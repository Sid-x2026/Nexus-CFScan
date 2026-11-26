/**
 * 裂变 + 订阅生成（纯函数，与 Nexus-Argo 面板 / sub-server.py 同一套逻辑）。
 *
 * 规则（原样移植自 web/sub-server.py）：
 * - 裂变只换链接里的 host，其余原样保留，SNI / UUID / 端口 / 路径都不变；
 * - 直连节点不裂变，原样跟上；隧道（Argo）节点才按优选地址裂变；
 * - V2Ray / sing-box 订阅都是 base64 的链接列表；sing-box 格式只去掉
 *   xhttp 节点与带 VLESS 加密层的节点（sing-box 不支持这两者），其余照留；
 * - Clash 订阅是 Mihomo YAML（xhttp 需 Mihomo 1.19+；带 VLESS 加密层
 *   的节点 Mihomo 不支持，直接跳过）。
 */

// ---------- base64（UTF-8 安全） ----------

export function b64encodeUtf8(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

export function b64decodeUtf8(b64: string): string {
    const cleaned = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

// ---------- 订阅解析 / 编码 ----------

/** 订阅内容解析：明文按行取，base64 解开再按行取（与 nexus-sub 一致）。 */
export function decodeSubscription(text: string): string[] {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    if (trimmed.includes('://')) {
        return trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    }
    try {
        const decoded = b64decodeUtf8(trimmed);
        const lines = decoded.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0 && lines.some((l) => l.includes('://'))) return lines;
    } catch {
        // 不是合法 base64，按明文行处理
    }
    return trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** 订阅内容编码：链接按行拼好后整体标准 base64（与 Worker / 面板一致）。 */
export function encodeSubscription(lines: string[]): string {
    const text = lines.join('\n') + (lines.length > 0 ? '\n' : '');
    return b64encodeUtf8(text);
}

// ---------- 裂变 ----------

const FISSION_RE = /^([a-zA-Z0-9+.-]+:\/\/[^@]+@)([^:/?#]+)(:\d+.*)$/;

/** 一条链接裂变：只换 host；addr 可带端口（1.2.3.4:2053），带了就连端口一起换，
 *  不带沿用原生链接的端口。namePrefix 有值时加到备注最前面（裂变|日本|原备注），
 *  suffix 有值时追加到备注后面（原备注丨HKG 60ms）。 */
export function fissionLink(link: string, addr: string, suffix?: string, namePrefix?: string): string | null {
    const m = FISSION_RE.exec(link);
    if (!m) return null;
    let host = addr;
    let port = '';
    const colonIdx = addr.lastIndexOf(':');
    if (colonIdx > 0 && /^\d+$/.test(addr.slice(colonIdx + 1))) {
        host = addr.slice(0, colonIdx);
        port = addr.slice(colonIdx + 1);
    }
    let rest = m[3]; // :原生端口 + 后面（查询串 / 备注）
    if (port) rest = ':' + port + rest.replace(/^:\d+/, '');
    let out = m[1] + host + rest;
    if (suffix || namePrefix) {
        const hashIdx = out.indexOf('#');
        if (hashIdx >= 0) {
            let frag = out.slice(hashIdx + 1);
            try {
                frag = decodeURIComponent(frag);
            } catch {
                // 备注不是合法百分号编码，原样保留
            }
            let newFrag = frag;
            if (namePrefix) newFrag = namePrefix + '|' + newFrag;
            if (suffix) newFrag = newFrag + '丨' + suffix;
            out = out.slice(0, hashIdx + 1) + newFrag;
        } else {
            const parts = [namePrefix, suffix].filter(Boolean);
            out = out + '#' + parts.join('丨');
        }
    }
    return out;
}

export interface FissionAddr {
    /** 裂变用的地址：域名源用解析出的实际 IP，其余用 IP 本身 */
    addr: string;
    /** 追加到备注的后缀，如 "HKG 60ms"；没有机房信息时用 IP 本身 */
    suffix: string;
}

/** 按备注第一段区分：直连节点原样跟上，不裂变；其余按隧道节点裂变。 */
export function isDirectLink(link: string): boolean {
    const hashIdx = link.indexOf('#');
    if (hashIdx < 0) return false;
    let remark = link.slice(hashIdx + 1);
    try {
        remark = decodeURIComponent(remark);
    } catch {
        // 解不开就按原文判断
    }
    const first = remark.split('丨')[0] || '';
    return first === '直连';
}

export interface FissionResult {
    links: string[];
    /** 原生里的隧道节点数 */
    argoCount: number;
    /** 原生里的直连节点数（原样跟上） */
    directCount: number;
    /** 实际用于裂变的优选地址数 */
    addrCount: number;
}

/**
 * 裂变一批原生链接。
 * mode 'one'：每条隧道协议按延迟顺序配 1 个不同 IP，IP 不够的协议保留原生地址；
 * mode 'all'：每条隧道协议 × 全部优选地址（与面板 merged 相同）。
 */
export function fissionLinks(
    nativeLinks: string[],
    addrs: FissionAddr[],
    mode: 'one' | 'all',
    namePrefix?: string,
): FissionResult {
    const links: string[] = [];
    let argoCount = 0;
    let directCount = 0;
    const argoLinks: string[] = [];
    for (const link of nativeLinks) {
        if (isDirectLink(link)) {
            directCount++;
            links.push(link);
        } else {
            argoCount++;
            argoLinks.push(link);
        }
    }
    const fissioned: string[] = [];
    if (mode === 'all') {
        for (const link of argoLinks) {
            for (const a of addrs) {
                const f = fissionLink(link, a.addr, a.suffix, namePrefix);
                if (f) fissioned.push(f);
            }
        }
    } else {
        argoLinks.forEach((link, i) => {
            const a = addrs[i];
            if (!a) {
                // IP 不够：这条协议保留原生地址，不断网
                fissioned.push(link);
                return;
            }
            const f = fissionLink(link, a.addr, a.suffix, namePrefix);
            if (f) fissioned.push(f);
        });
    }
    // 直连原样跟在最后（与面板 _agg_build 顺序一致）
    return {
        links: [...fissioned, ...links.filter((l) => isDirectLink(l))],
        argoCount,
        directCount,
        addrCount: addrs.length,
    };
}

export interface CustomAddrResult {
    addrs: FissionAddr[];
    /** 格式不对的行（原样返回，前端提示用户改） */
    invalid: string[];
    /** 有效行超过 20 个时只取前 20 个（与面板上限一致） */
    truncated: boolean;
}

const CUSTOM_ADDR_RE = /^[A-Za-z0-9._-]+(:\d+)?$/;

/** 解析自定义裂变对象：每行一个 IP 或域名，可带端口；去重，最多 20 个。 */
export function parseCustomAddrs(text: string): CustomAddrResult {
    const addrs: FissionAddr[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    let truncated = false;
    for (const raw of (text || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (!CUSTOM_ADDR_RE.test(line) || line.length > 253) {
            invalid.push(line);
            continue;
        }
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (addrs.length >= 20) {
            truncated = true;
            continue;
        }
        addrs.push({ addr: line, suffix: line.split(':')[0] });
    }
    return { addrs, invalid, truncated };
}

/** 取一条链接的备注（解码后）。 */
export function linkRemark(link: string): string {
    const hashIdx = link.indexOf('#');
    if (hashIdx < 0) return '';
    try {
        return decodeURIComponent(link.slice(hashIdx + 1));
    } catch {
        return link.slice(hashIdx + 1);
    }
}

/** 只改一条链接的备注（节点名称），其余部分原样保留。 */
export function renameLinkName(link: string, newName: string): string {
    const hashIdx = link.indexOf('#');
    if (hashIdx < 0) return link + '#' + newName;
    return link.slice(0, hashIdx + 1) + newName;
}

// ---------- 链接解析（供 Clash / sing-box 格式转换用） ----------

export interface ParsedLink {
    scheme: string;
    uuid: string;
    password: string;
    addr: string;
    port: number;
    type: string;
    security: string;
    sni: string;
    path: string;
    mode: string;
    svc: string;
    alpn: string;
    allowInsecure: boolean;
    pbk: string;
    sid: string;
    fp: string;
    flow: string;
    encryption: string;
    spiderx: string;
    cipher: string;
    remark: string;
}

function parseQuery(u: URL, key: string, fallback = ''): string {
    return u.searchParams.get(key) ?? fallback;
}

function parseVless(link: string): ParsedLink | null {
    try {
        const u = new URL(link);
        if (u.protocol !== 'vless:' || !u.hostname || !u.port) return null;
        return {
            scheme: 'vless',
            uuid: decodeURIComponent(u.username || ''),
            password: decodeURIComponent(u.username || ''),
            addr: u.hostname,
            port: Number(u.port),
            type: parseQuery(u, 'type', ''),
            security: parseQuery(u, 'security', ''),
            sni: parseQuery(u, 'sni', ''),
            path: parseQuery(u, 'path', '/'),
            mode: parseQuery(u, 'mode', 'auto'),
            svc: parseQuery(u, 'serviceName', ''),
            alpn: parseQuery(u, 'alpn', ''),
            allowInsecure: parseQuery(u, 'allowInsecure', '') === '1',
            pbk: parseQuery(u, 'pbk', ''),
            sid: parseQuery(u, 'sid', ''),
            fp: parseQuery(u, 'fp', ''),
            flow: parseQuery(u, 'flow', ''),
            encryption: parseQuery(u, 'encryption', ''),
            spiderx: parseQuery(u, 'spiderX', ''),
            cipher: '',
            remark: decodeURIComponent(u.hash ? u.hash.slice(1) : ''),
        };
    } catch {
        return null;
    }
}

function baseParsed(over: Partial<ParsedLink> & { scheme: string }): ParsedLink {
    return {
        uuid: '', password: '', addr: '', port: 0, type: 'tcp', security: 'tls',
        sni: '', path: '/', mode: 'auto', svc: '', alpn: '', allowInsecure: false,
        pbk: '', sid: '', fp: '', flow: '', encryption: '', spiderx: '', cipher: '',
        remark: '', ...over,
    };
}

export function parseLink(link: string): ParsedLink | null {
    if (!link || !link.includes('://')) return null;
    const scheme = link.split('://', 1)[0].toLowerCase();
    if (scheme === 'vless') return parseVless(link);
    try {
        if (scheme === 'trojan') {
            const u = new URL(link);
            if (!u.username || !u.hostname || !u.port) return null;
            return baseParsed({
                scheme: 'trojan', uuid: decodeURIComponent(u.username),
                password: decodeURIComponent(u.username), addr: u.hostname, port: Number(u.port),
                security: parseQuery(u, 'security', 'tls'), sni: parseQuery(u, 'sni', ''),
                alpn: parseQuery(u, 'alpn', ''),
                allowInsecure: parseQuery(u, 'allowInsecure', '') === '1',
                remark: decodeURIComponent(u.hash ? u.hash.slice(1) : ''),
            });
        }
        if (scheme === 'vmess') {
            const body = link.slice('vmess://'.length).split('#', 1)[0];
            const frag = link.includes('#') ? decodeURIComponent(link.split('#', 1)[1]) : '';
            const cfg = JSON.parse(b64decodeUtf8(body)) as Record<string, unknown>;
            const str = (k: string): string => String(cfg[k] ?? '');
            return baseParsed({
                scheme: 'vmess', uuid: str('id'), password: str('id'),
                addr: str('add'), port: Number(cfg['port'] || 0),
                type: str('net') || 'ws', security: cfg['tls'] === 'tls' ? 'tls' : 'none',
                sni: str('sni') || str('host'), path: str('path') || '/ws',
                cipher: 'auto', remark: frag || str('ps'),
            });
        }
        if (scheme === 'ss') {
            const body = link.slice('ss://'.length).split('#', 1)[0];
            const frag = link.includes('#') ? decodeURIComponent(link.split('#', 1)[1]) : '';
            if (body.includes('@') && !body.startsWith('eyJ')) {
                // SIP002 形式：ss://base64(method:password)@host:port
                const atIdx = body.lastIndexOf('@');
                const userinfo = body.slice(0, atIdx);
                const hostport = body.slice(atIdx + 1);
                const [method, password] = b64decodeUtf8(userinfo).split(':', 2);
                const [host, port] = hostport.split(':', 2);
                return baseParsed({
                    scheme: 'ss', uuid: password || '', password: password || '',
                    addr: host || '', port: Number(port || 0), type: 'ss', security: 'none',
                    cipher: method || '', remark: frag,
                });
            }
            const decoded = b64decodeUtf8(body);
            const colonIdx = decoded.indexOf(':');
            const atIdx = decoded.indexOf('@', colonIdx);
            const method = decoded.slice(0, colonIdx);
            const password = decoded.slice(colonIdx + 1, atIdx);
            const hostport = decoded.slice(atIdx + 1);
            const [host, port] = hostport.split(':', 2);
            if (!method || !password || !host || !port) return null;
            return baseParsed({
                scheme: 'ss', uuid: password, password, addr: host, port: Number(port),
                type: 'ss', security: 'none', cipher: method, remark: frag,
            });
        }
        if (scheme === 'hysteria2') {
            const u = new URL(link);
            if (!u.username || !u.hostname || !u.port) return null;
            return baseParsed({
                scheme: 'hysteria2', uuid: decodeURIComponent(u.username),
                password: decodeURIComponent(u.username), addr: u.hostname, port: Number(u.port),
                type: 'hysteria2', security: 'tls', sni: parseQuery(u, 'sni', ''),
                alpn: parseQuery(u, 'alpn', ''),
                allowInsecure: ['1', 'true'].includes(parseQuery(u, 'insecure', '')),
                remark: decodeURIComponent(u.hash ? u.hash.slice(1) : ''),
            });
        }
    } catch {
        return null;
    }
    return null;
}

export function vlessType(link: string): string {
    const p = parseLink(link);
    return p && p.scheme === 'vless' ? p.type : '';
}

/** Sing-box / Clash 不支持 VLESS Encryption，带加密层的节点在这些格式里要去掉。 */
export function hasVlessEncryption(link: string): boolean {
    const p = parseLink(link);
    if (!p || p.scheme !== 'vless') return false;
    const enc = p.encryption || '';
    return enc !== '' && enc !== 'none';
}

/** sing-box 订阅：只去掉 xhttp 节点与带 VLESS 加密层的节点，其余都留着。 */
export function singboxLinks(links: string[]): { links: string[]; dropped: number } {
    const kept = links.filter((l) => vlessType(l) !== 'xhttp' && !hasVlessEncryption(l));
    return { links: kept, dropped: links.length - kept.length };
}

// ---------- Clash YAML ----------

function yq(s: string): string {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export interface ClashResult {
    yaml: string;
    /** 因不支持而跳过的节点数 */
    skipped: number;
}

/** 链接 -> Mihomo (Clash Meta) YAML。传输映射与 sub-server.py 一致。 */
export function clashYaml(links: string[]): ClashResult {
    const proxies: ParsedLink[] = [];
    let skipped = 0;
    for (const link of links) {
        const p = parseLink(link);
        if (!p || !p.uuid || !p.addr || !p.port) {
            skipped++;
            continue;
        }
        if (p.scheme === 'vless' && !['xhttp', 'ws', 'httpupgrade', 'grpc', 'tcp'].includes(p.type)) {
            skipped++;
            continue;
        }
        if (p.scheme === 'vless' && (p.encryption || 'none') !== 'none' && p.encryption !== '') {
            skipped++;
            continue;
        }
        if (!['vless', 'trojan', 'vmess', 'ss', 'hysteria2'].includes(p.scheme)) {
            skipped++;
            continue;
        }
        proxies.push(p);
    }
    if (proxies.length === 0) return { yaml: '', skipped };
    const out: string[] = [
        '# Nexus-CFScan Clash 订阅 (Mihomo / Clash Meta 1.19+；原版 Clash 不支持 VLESS)',
        'proxies:',
    ];
    const names: string[] = [];
    for (const p of proxies) {
        const parts = (p.remark || '').split('丨').filter(Boolean);
        const name = parts.length > 0 ? `${parts.join('-')} @ ${p.addr}` : `${p.scheme} @ ${p.addr}`;
        names.push(name);
        out.push(`  - name: ${yq(name)}`);
        if (p.scheme === 'trojan') {
            out.push('    type: trojan');
            out.push(`    server: ${yq(p.addr)}`);
            out.push(`    port: ${p.port}`);
            out.push(`    password: ${yq(p.password)}`);
            if (p.sni) out.push(`    sni: ${yq(p.sni)}`);
            if (p.alpn) {
                out.push('    alpn:');
                out.push(`      - ${yq(p.alpn)}`);
            }
            if (p.allowInsecure) out.push('    skip-cert-verify: true');
            out.push('    udp: true');
            continue;
        }
        if (p.scheme === 'vmess') {
            out.push('    type: vmess');
            out.push(`    server: ${yq(p.addr)}`);
            out.push(`    port: ${p.port}`);
            out.push(`    uuid: ${yq(p.uuid)}`);
            out.push('    alterId: 0');
            out.push('    cipher: auto');
            out.push(`    tls: ${p.security === 'tls' ? 'true' : 'false'}`);
            if (p.sni) out.push(`    servername: ${yq(p.sni)}`);
            if (p.type === 'ws') {
                out.push('    network: ws');
                out.push('    ws-opts:');
                out.push(`      path: ${yq(p.path)}`);
                out.push('      headers:');
                out.push(`        Host: ${yq(p.sni || p.addr)}`);
            }
            out.push('    udp: true');
            continue;
        }
        if (p.scheme === 'ss') {
            out.push('    type: ss');
            out.push(`    server: ${yq(p.addr)}`);
            out.push(`    port: ${p.port}`);
            out.push(`    cipher: ${yq(p.cipher || 'aes-256-gcm')}`);
            out.push(`    password: ${yq(p.password)}`);
            out.push('    udp: true');
            continue;
        }
        if (p.scheme === 'hysteria2') {
            out.push('    type: hysteria2');
            out.push(`    server: ${yq(p.addr)}`);
            out.push(`    port: ${p.port}`);
            out.push(`    password: ${yq(p.password)}`);
            if (p.sni) out.push(`    sni: ${yq(p.sni)}`);
            out.push('    alpn:');
            for (const a of p.alpn ? p.alpn.split(',') : ['h3']) {
                out.push(`      - ${yq(a.trim())}`);
            }
            if (p.allowInsecure) out.push('    skip-cert-verify: true');
            continue;
        }
        // vless
        out.push('    type: vless');
        out.push(`    server: ${yq(p.addr)}`);
        out.push(`    port: ${p.port}`);
        out.push(`    uuid: ${yq(p.uuid)}`);
        const tls = p.security === 'tls' || p.security === 'reality';
        out.push(`    tls: ${tls ? 'true' : 'false'}`);
        if (p.sni) out.push(`    servername: ${yq(p.sni)}`);
        if (p.alpn) {
            out.push('    alpn:');
            out.push(`      - ${yq(p.alpn)}`);
        }
        if (p.allowInsecure) out.push('    skip-cert-verify: true');
        if (p.type === 'xhttp') {
            out.push('    network: xhttp');
            out.push('    xhttp-opts:');
            out.push(`      path: ${yq(p.path)}`);
            out.push(`      mode: ${yq(p.mode)}`);
        } else if (p.type === 'ws') {
            out.push('    network: ws');
            out.push('    ws-opts:');
            out.push(`      path: ${yq(p.path)}`);
            out.push('      headers:');
            out.push(`        Host: ${yq(p.sni || p.addr)}`);
        } else if (p.type === 'httpupgrade') {
            out.push('    network: ws');
            out.push('    ws-opts:');
            out.push(`      path: ${yq(p.path)}`);
            out.push('      headers:');
            out.push(`        Host: ${yq(p.sni || p.addr)}`);
            out.push('    v2ray-http-upgrade: true');
        } else if (p.type === 'grpc') {
            out.push('    network: grpc');
            out.push('    grpc-opts:');
            out.push(`      grpc-service-name: ${yq(p.svc || 'grpc')}`);
        } else if (p.type === 'tcp') {
            if (p.security === 'reality') {
                out.push('    network: tcp');
                out.push('    reality-opts:');
                out.push(`      public-key: ${yq(p.pbk)}`);
                out.push(`      short-id: ${yq(p.sid)}`);
            }
        }
        out.push('    udp: true');
    }
    out.push('proxy-groups:');
    out.push(`  - name: ${yq('Argo')}`);
    out.push('    type: select');
    out.push('    proxies:');
    for (const n of names) out.push(`      - ${yq(n)}`);
    return { yaml: out.join('\n') + '\n', skipped };
}
