// e:\CODE\kgcfip\src\utils\scanner.ts
/**
 * 扫描结果的数据结构
 *
 * 测速全部由本地后端（CFData-Web 思路的 Go 本地服务）执行，前端只负责
 * 下发参数、展示后端回传的达标结果。本文件不再包含任何浏览器端测速逻辑。
 */
export type SourceKind = 'cf' | 'cm' | 'domain' | 'third';

export const SOURCE_LABELS: Record<SourceKind, string> = {
    cf: 'CF源',
    cm: 'CM整理',
    domain: '域名扫描',
    third: '第三方',
};

/** 默认仅保留亚洲机房（与优选地址的机房范围一致） */
export const ASIAN_COLOS = ['HKG', 'NRT', 'SIN', 'ICN', 'TPE'];

/** 美国常用机房 */
export const US_COLOS = ['LAX', 'SFO', 'SEA', 'ORD', 'IAD', 'JFK'];

/** 欧洲常用机房 */
export const EU_COLOS = ['LHR', 'FRA', 'AMS', 'CDG'];

/** 常用机房全集（亚洲 + 美国 + 欧洲）：选项全有，默认只勾亚洲 5 个，不用也不能没有 */
export const COMMON_COLOS = [...ASIAN_COLOS, ...US_COLOS, ...EU_COLOS];

/** CF 优选端口（BestCF 同款）：固定任选其一，或随机 */
export const CF_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

export interface ScanResult {
    ip: string;
    port: number;
    isAvailable: boolean;
    /** 最好一次延迟（3 次取最小），即达标判定用的延迟 */
    latency: number;
    colo?: string; // Cloudflare 数据中心代码
    domain?: boolean; // 是否为域名源（保存域名而非解析出的IP）

    // 以下为本地后端测速的扩展字段，全部可选，保证与原有
    // 「保存为场景 / 导出 / 筛选」等逻辑完全兼容。
    tcpMs?: number;        // TCP 三次握手耗时
    tlsMs?: number;        // 累计到 TLS 握手完成的耗时
    error?: string;        // 不可用时的原因
    /** 3 次实测延迟（按测速轮次顺序），后端回传 */
    latencies?: number[];
    /** 丢包率（%），失败次数 / 测速轮次 */
    lossPct?: number;
    /** 抖动（ms），3 次延迟的最大值 - 最小值 */
    jitterMs?: number;
    /** 入选后测速速率（MB/s），后端回传，未测速时为空 */
    speedMbps?: number;
    /** 结果来源：cf / cm / domain / third */
    source?: SourceKind;
    /** 每条源的标签（如 'CF官方IP段'、'bestcf.pages.dev/domain/all.txt'、'手动粘贴'）；
     *  用于扫完后的按源汇总，与 source（SourceKind）分开保存，不影响结果筛选。 */
    sourceLabel?: string;
    /** 域名源时 DoH 解析出的实际连接 IP（展示仍用域名）；单条探针/测速用它直连，
     *  避免对域名重新解析到另一个 IP。IP 源时与 ip 相同。 */
    resolvedIp?: string;
}

/** 前端可自定义的扫描参数（保存后下次沿用，见 DEFAULT_SCAN_PARAMS） */
export interface ScanParams {
    count: number;          // 随机 IP 数量（CF/CM 源）
    threads: number;        // 并发线程数
    latencyLimit: number;   // 延迟上限（ms），3 次取最好一次
    lossLimit: number;      // 丢包上限（%），3 次均须达标
    rounds: number;         // 测速轮次
    jitterStable: number;   // 抖动分档：≤ 此值优先
    jitterBackup: number;   // 抖动分档：≤ 此值为备用，超过则降级
    timeoutMs: number;      // 单次请求超时（ms）
    coloFilter: string[];   // 机房筛选
    topN: number;           // 输出数量（按延迟排序取前 N 条）
    scanMode: 'tcping' | 'httping'; // 扫描方式
    speedUrl: string;       // 测速地址，'auto' 为自动选择
}

/** 扫描参数默认值（与 SHU 定好的规则一致） */
export const DEFAULT_SCAN_PARAMS: ScanParams = {
    count: 500,
    threads: 8,
    latencyLimit: 180,
    lossLimit: 10,
    rounds: 3,
    jitterStable: 50,
    jitterBackup: 100,
    timeoutMs: 5000,
    coloFilter: [...ASIAN_COLOS],
    topN: 20,
    scanMode: 'tcping',
    speedUrl: 'auto',
};

export type JitterTier = 'stable' | 'backup' | 'demoted';

/** 按抖动分档：≤ stable 优先，≤ backup 备用，超过降级 */
export function jitterTier(jitterMs: number | undefined, params: Pick<ScanParams, 'jitterStable' | 'jitterBackup'>): JitterTier {
    if (jitterMs === undefined) return 'stable';
    if (jitterMs <= params.jitterStable) return 'stable';
    if (jitterMs <= params.jitterBackup) return 'backup';
    return 'demoted';
}

/**
 * 达标判定（与后端保持同一口径，前端再做一次兜底过滤）：
 * 延迟 3 次取最好一次 ≤ 延迟上限，且丢包 ≤ 丢包上限。
 * 后端只回传达标结果，前端展示的即为已达标结果。
 */
export function isQualified(
    r: ScanResult,
    params: Pick<ScanParams, 'latencyLimit' | 'lossLimit'>,
): boolean {
    if (!r.isAvailable || r.latency < 0) return false;
    if (r.latency > params.latencyLimit) return false;
    if (r.lossPct !== undefined && r.lossPct > params.lossLimit) return false;
    return true;
}

/**
 * 判断一个 host 是否为域名（非 IPv4 / IPv6）
 */
export function isDomainName(host: string): boolean {
    // IPv6（含方括号或包含多个冒号）一律视为IP
    if (host.includes(':')) return false;
    // IPv4
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
    // 形如 example.com
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(host);
}

/**
 * 通过阿里云公共 DNS (DoH) 将域名解析为 IP（优先 A 记录，其次 AAAA）
 * 使用 dns.alidns.com，在大陆网络环境下可正常访问。
 * 仅用于准备靶标：把域名解析出实际连接 IP 交给本地后端，测速本身由后端做。
 */
export async function resolveDomainToIp(host: string): Promise<string | null> {
    const query = (type: 'A' | 'AAAA') =>
        fetch(`https://dns.alidns.com/resolve?name=${encodeURIComponent(host)}&type=${type}`);

    try {
        const resA = await query('A');
        if (resA.ok) {
            const json = await resA.json() as { Status?: number; Answer?: { type: number; data: string }[] };
            if (json.Status === 0) {
                const a = json.Answer?.find(r => r.type === 1);
                if (a) return a.data;
            }
        }
        const resAAAA = await query('AAAA');
        if (resAAAA.ok) {
            const json = await resAAAA.json() as { Status?: number; Answer?: { type: number; data: string }[] };
            if (json.Status === 0) {
                const aaaa = json.Answer?.find(r => r.type === 28);
                if (aaaa) return aaaa.data;
            }
        }
    } catch {
        // 解析失败
    }
    return null;
}

/**
 * 解析用户直接粘贴 / 本地上传的条目（一行一个）：
 * 支持 IP、域名、IP:端口、域名:端口、[IPv6]:端口，忽略空行与 # 注释。
 * 第三方源里非 URL 的行、本地上传文件的内容都走这里直接解析，
 * 不经过后端拉取（后端第三方接口只拉取 URL）。
 */
export function parseDirectEntries(text: string, defaultPort = 443): { host: string; port: number }[] {
    const out: { host: string; port: number }[] = [];
    for (const rawLine of text.split(/[\r\n]+/)) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
        // CSV 文件常见格式：IP,端口 或 域名,端口
        const line = trimmed.split(',')[0].trim();
        const hashIndex = line.indexOf('#');
        const ipPart = (hashIndex > -1 ? line.substring(0, hashIndex) : line).trim();
        if (!ipPart || ipPart.toLowerCase().includes('http')) continue;
        let host = ipPart;
        let port = defaultPort;
        const lastColon = ipPart.lastIndexOf(':');
        const closeBracket = ipPart.lastIndexOf(']');
        if (lastColon > -1 && lastColon > closeBracket) {
            const p = parseInt(ipPart.substring(lastColon + 1), 10);
            if (!isNaN(p)) {
                port = p;
                host = ipPart.substring(0, lastColon);
                if (host.startsWith('[') && host.endsWith(']')) host = host.substring(1, host.length - 1);
            }
        }
        if (host) out.push({ host, port });
    }
    return out;
}

// =================================================================
// 1. 地区分组逻辑 (源于参考代码)
// =================================================================

export { coloMap, getColoName } from './colo';

// =================================================================
// 2. IP 生成器
// =================================================================

/**
 * 从 CIDR 块生成随机 IP
 */
function generateRandomIPFromCIDR(cidr: string): string {
    const [baseIP, prefixLength] = cidr.split('/');
    const prefix = parseInt(prefixLength, 10);

    if (prefix === 32) return baseIP;

    const hostBits = 32 - prefix;
    const ipParts = baseIP.split('.').map(p => parseInt(p, 10));

    const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
    const randomOffset = Math.floor(Math.random() * (2 ** hostBits));
    const mask = (0xFFFFFFFF << hostBits) >>> 0;
    const randomIPInt = ((ipInt & mask) >>> 0) + randomOffset;

    return [
        (randomIPInt >>> 24) & 0xFF,
        (randomIPInt >>> 16) & 0xFF,
        (randomIPInt >>> 8) & 0xFF,
        randomIPInt & 0xFF
    ].join('.');
}

/**
 * 从 CIDR 列表生成指定数量的随机 IP
 */
export function generateRandomIps(cidrs: string[], count: number): string[] {
    if (!cidrs || cidrs.length === 0) {
        return [];
    }
    const randomIps = new Set<string>();
    const maxAttempts = count * 5;
    let attempts = 0;

    while (randomIps.size < count && attempts < maxAttempts) {
        const randomCidr = cidrs[Math.floor(Math.random() * cidrs.length)];
        const randomIp = generateRandomIPFromCIDR(randomCidr);
        randomIps.add(randomIp);
        attempts++;
    }
    return Array.from(randomIps);
}

/** 单个 CIDR 包含的 IP 总数：2^(32-prefix) */
export function cidrSize(cidr: string): number {
    const parts = cidr.split('/');
    if (parts.length !== 2) return 0;
    const prefix = parseInt(parts[1], 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return 0;
    return 2 ** (32 - prefix);
}

/** 一组 CIDR 的 IP 总数 */
export function totalIps(cidrs: string[]): number {
    return cidrs.reduce((sum, c) => sum + cidrSize(c), 0);
}

/** IP 总数显示：过万用「万」，以下千分位 */
export function formatIpCount(n: number): string {
    if (n >= 10000) {
        const w = (n / 10000).toFixed(1).replace(/\.0$/, '');
        return `${w} 万`;
    }
    return n.toLocaleString('en-US');
}

/** 按顺序枚举一个 CIDR 里的全部 IP（不含广播/网络地址区分，全段都扫） */
function enumerateIpsFromCIDR(cidr: string): string[] {
    const [baseIP, prefixLength] = cidr.split('/');
    const prefix = parseInt(prefixLength, 10);
    if (prefix === 32) return [baseIP];
    const hostBits = 32 - prefix;
    const total = 2 ** hostBits;
    const ipParts = baseIP.split('.').map(p => parseInt(p, 10));
    const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
    const mask = (0xFFFFFFFF << hostBits) >>> 0;
    const base = (ipInt & mask) >>> 0;
    const out: string[] = [];
    for (let i = 0; i < total; i++) {
        const v = (base + i) >>> 0;
        out.push([(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF].join('.'));
    }
    return out;
}

/**
 * 按 SHU 的规则生成本次扫描目标（2026-11-27 定：20000 上限取消，数量由用户自己控制）：
 * 随机数 ≥ 选中段的 IP 总数 → 全扫（按顺序枚举，不重不漏）；
 * 随机数 < 总数 → 随机抽指定个数。
 */
export function generateIps(cidrs: string[], count: number): string[] {
    if (!cidrs || cidrs.length === 0) {
        return [];
    }
    const total = totalIps(cidrs);
    if (count >= total) {
        const all: string[] = [];
        for (const cidr of cidrs) all.push(...enumerateIpsFromCIDR(cidr));
        return all;
    }
    return generateRandomIps(cidrs, count);
}

/** 生成计划：供界面提前显示「本次全扫 / 随机抽几个」 */
export function planIpGeneration(cidrs: string[], count: number): { mode: 'all' | 'random'; total: number; planned: number } {
    const total = totalIps(cidrs);
    if (count >= total) {
        return { mode: 'all', total, planned: total };
    }
    return { mode: 'random', total, planned: count };
}

// =================================================================
// 3. 其他工具函数
// =================================================================

/**
 * 根据延迟值获取颜色样式
 */
export const getLatencyColor = (latency: number): string => {
    if (latency < 0) return 'text-gray-400 dark:text-gray-500';
    if (latency < 200) return 'text-green-500 dark:text-green-400';
    if (latency < 500) return 'text-yellow-500 dark:text-yellow-400';
    return 'text-red-500 dark:text-red-400';
};


/**
 * 备用的 Cloudflare CIDR 列表。
 * 此列表已废弃，CIDR数据现在应完全从API/KV中获取。
 * 保留为空数组以确保类型兼容和旧逻辑的平稳过渡。
 */
export const CF_CIDR_LIST: string[] = [];
