import { useState, useRef, useEffect, useCallback } from 'react';
import { CloudflareIps, getThirdPartySourceList, getThirdPartySourceIps } from '../api';

type SourceRowStatus = 'pending' | 'loading' | 'done' | 'error';
interface SourceRow {
    url: string;
    status: SourceRowStatus;
    ipCount?: number;
    domainCount?: number;
    error?: string;
    ips?: { ip: string; port: number }[];
}
import {
    generateRandomIps,
    ScanResult,
    CF_CIDR_LIST,
    isDomainName,
    resolveDomainToIp,
    DEFAULT_SCAN_PARAMS,
    ASIAN_COLOS,
    COMMON_COLOS,
    US_COLOS,
    EU_COLOS,
    CF_PORTS,
    isQualified,
    parseDirectEntries,
    SOURCE_LABELS,
    type SourceKind,
} from '../utils/scanner';
import {
    probeLocalAgent, startAgentScan, fetchAgentProgress, stopAgentScan,
    DEFAULT_AGENT_PORT,
    type AgentResult, type AgentProbeResult,
} from '../utils/localAgent';
import { useToast } from './Toast';
import { Gauge, Play, StopCircle, Loader2, Square, Cpu, RefreshCw, Download } from 'lucide-react';
import { useConfirm } from './ConfirmDialog';

interface IpScannerConfigAndControlProps {
    cfIps: CloudflareIps | null;
    onScanComplete: (results: ScanResult[]) => void;
}

/** 扫描参数持久化：localStorage，下次打开自动沿用 */
const SCAN_PARAMS_KEY = 'CF_SCAN_PARAMS';
const DOMAIN_LIST_KEY = 'CF_DOMAIN_LIST';
const THIRD_DIRECT_KEY = 'THIRD_PARTY_DIRECT_ENTRIES';
/** 探针域名持久化：localStorage，下次打开自动沿用 */
const PROBE_HOST_KEY = 'CF_PROBE_HOST';
/** BestCF 域名列表（cmliu/CF-Pages-BestCF 的 cf_domains.txt），域名源一键导入 */
const BESTCF_DOMAINS_URLS = [
    'https://raw.githubusercontent.com/cmliu/CF-Pages-BestCF/main/cf_domains.txt',
    'https://cdn.jsdelivr.net/gh/cmliu/CF-Pages-BestCF@main/cf_domains.txt',
];

function loadSavedParams() {
    try {
        const raw = localStorage.getItem(SCAN_PARAMS_KEY);
        if (!raw) return DEFAULT_SCAN_PARAMS;
        return { ...DEFAULT_SCAN_PARAMS, ...JSON.parse(raw) };
    } catch {
        return DEFAULT_SCAN_PARAMS;
    }
}

export function ScannerConfig({ cfIps, onScanComplete }: IpScannerConfigAndControlProps) {
    const saved = loadSavedParams();
    // ---------- 扫描参数（全部可自定义，改动即保存，下次沿用） ----------
    const [count, setCount] = useState<string>(String(saved.count));
    const [threads, setThreads] = useState<string>(String(saved.threads));
    const [latencyLimit, setLatencyLimit] = useState<string>(String(saved.latencyLimit));
    const [lossLimit, setLossLimit] = useState<string>(String(saved.lossLimit));
    const [rounds, setRounds] = useState<string>(String(saved.rounds));
    const [jitterStable, setJitterStable] = useState<string>(String(saved.jitterStable));
    const [jitterBackup, setJitterBackup] = useState<string>(String(saved.jitterBackup));
    const [timeoutMs, setTimeoutMs] = useState<string>(String(saved.timeoutMs));
    const [topN, setTopN] = useState<string>(String(saved.topN));
    const [speedUrl, setSpeedUrl] = useState<string>(saved.speedUrl);
    const [scanMode, setScanMode] = useState<'tcping' | 'httping'>(saved.scanMode);
    /** 探针域名：节点域名（如 jpagxr.sidns.xyz），后端用它当 SNI 做连通性探针；留空用 speed.cloudflare.com */
    const [probeHost, setProbeHost] = useState<string>(
        () => { try { return localStorage.getItem(PROBE_HOST_KEY) || ''; } catch { return ''; } }
    );

    // 探针域名变动即保存
    useEffect(() => {
        try { localStorage.setItem(PROBE_HOST_KEY, probeHost.trim()); } catch { /* 忽略 */ }
    }, [probeHost]);
    const [portMode, setPortMode] = useState<'fixed' | 'random'>('fixed');
    const [selectedPort, setSelectedPort] = useState(443);
    const [coloFilter, setColoFilter] = useState<string[]>(saved.coloFilter);
    const [countError, setCountError] = useState<string>('');
    const [threadsError, setThreadsError] = useState<string>('');
    const [latencyLimitError, setLatencyLimitError] = useState<string>('');
    const [lossLimitError, setLossLimitError] = useState<string>('');
    const [roundsError, setRoundsError] = useState<string>('');
    const [timeoutError, setTimeoutError] = useState<string>('');
    const [topNError, setTopNError] = useState<string>('');
    const [jitterError, setJitterError] = useState<string>('');

    // 端口选择框的值：'random' 或端口号字符串
    const portSelectValue = portMode === 'random' ? 'random' : String(selectedPort);

    // 参数变动即保存
    useEffect(() => {
        const params = {
            count: parseInt(count, 10) || DEFAULT_SCAN_PARAMS.count,
            threads: parseInt(threads, 10) || DEFAULT_SCAN_PARAMS.threads,
            latencyLimit: parseInt(latencyLimit, 10) || DEFAULT_SCAN_PARAMS.latencyLimit,
            lossLimit: parseInt(lossLimit, 10) || DEFAULT_SCAN_PARAMS.lossLimit,
            rounds: parseInt(rounds, 10) || DEFAULT_SCAN_PARAMS.rounds,
            jitterStable: parseInt(jitterStable, 10) || DEFAULT_SCAN_PARAMS.jitterStable,
            jitterBackup: parseInt(jitterBackup, 10) || DEFAULT_SCAN_PARAMS.jitterBackup,
            timeoutMs: parseInt(timeoutMs, 10) || DEFAULT_SCAN_PARAMS.timeoutMs,
            topN: parseInt(topN, 10) || DEFAULT_SCAN_PARAMS.topN,
            speedUrl: speedUrl.trim() || 'auto',
            scanMode,
            coloFilter,
        };
        try { localStorage.setItem(SCAN_PARAMS_KEY, JSON.stringify(params)); } catch { /* 忽略 */ }
    }, [count, threads, latencyLimit, lossLimit, rounds, jitterStable, jitterBackup, timeoutMs, topN, speedUrl, scanMode, coloFilter]);

    const [ipSource, setIpSource] = useState<SourceKind>('cf');
    const [isScanning, setIsScanning] = useState(false);
    const [progress, setProgress] = useState(0);
    const [total, setTotal] = useState(0);
    const [successCount, setSuccessCount] = useState(0);
    const [failCount, setFailCount] = useState(0);
    // 达标数（成功数）的 ref：onDone 里算失败数 = 已测数 - 达标数时用，避免 state 闭包取到旧值
    const qualifiedCountRef = useRef(0);
    /** 本次扫描汇总（扫完后持久显示，不随进度浮窗消失） */
    interface ScanSummary {
        totalTested: number;
        totalQualified: number;
        dedupQualified: number;
        perSource: { label: string; tested: number; qualified: number }[];
    }
    const [lastScanSummary, setLastScanSummary] = useState<ScanSummary | null>(null);
    const [isStopping, setIsStopping] = useState(false);
    const [uniqueIpCount, setUniqueIpCount] = useState(0);
    const [grossIpCount, setGrossIpCount] = useState(0);
    const [ipCount, setIpCount] = useState(0);
    const [domainCount, setDomainCount] = useState(0);
    const [isPreparing, setIsPreparing] = useState(false);
    const [prepareDone, setPrepareDone] = useState(0);
    const [prepareTotal, setPrepareTotal] = useState(0);
    const [sourceRows, setSourceRows] = useState<SourceRow[]>([]);
    const [startTime, setStartTime] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());

    const cancelPreparingRef = useRef(false);
    const { showToast } = useToast();
    const { confirm } = useConfirm();

    // ---------- 域名源：BestCF cf_domains.txt 一键导入，或手动粘贴 ----------
    const [domainText, setDomainText] = useState<string>(
        () => localStorage.getItem(DOMAIN_LIST_KEY) || ''
    );
    const [importingDomains, setImportingDomains] = useState(false);
    const domainEntries = parseDirectEntries(domainText, selectedPort);

    const handleImportBestCfDomains = async () => {
        setImportingDomains(true);
        try {
            let text = '';
            for (const url of BESTCF_DOMAINS_URLS) {
                try {
                    const res = await fetch(url);
                    if (res.ok) { text = await res.text(); break; }
                } catch { /* 换下一个地址重试 */ }
            }
            if (!text.trim()) {
                showToast('导入 BestCF 域名列表失败，请检查网络后重试，或手动粘贴域名', 'error');
                return;
            }
            const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
            setDomainText(lines.join('\n'));
            localStorage.setItem(DOMAIN_LIST_KEY, lines.join('\n'));
            showToast(`已导入 BestCF 域名列表，共 ${lines.length} 个域名`, 'success');
        } finally {
            setImportingDomains(false);
        }
    };

    // ---------- 本地后端 ----------
    const [agentProbe, setAgentProbe] = useState<AgentProbeResult | null>(null);
    const [agentChecking, setAgentChecking] = useState(false);
    // 本地服务端口：保存在浏览器本地，下次自动带出
    const [agentPort, setAgentPort] = useState<string>(
        () => localStorage.getItem('LOCAL_AGENT_PORT') || String(DEFAULT_AGENT_PORT)
    );
    const agentStopRef = useRef(false);

    /** 探测本机 127.0.0.1 上的本地后端服务 */
    const checkAgent = useCallback(async (port: number, silent = false) => {
        setAgentChecking(true);
        try {
            const r = await probeLocalAgent(port);
            setAgentProbe(r);
            if (r.online && !silent) showToast('已连接到本地后端服务', 'success');
        } catch {
            setAgentProbe({ online: false, reason: 'offline' });
        } finally {
            setAgentChecking(false);
        }
    }, [showToast]);

    // 启动 & 端口变更：探测本地服务
    useEffect(() => {
        void checkAgent(Number(agentPort) || DEFAULT_AGENT_PORT, true);
    }, [checkAgent, agentPort]);

    const showLocationWarning = async () => {
        const result = await confirm('检测到您目前网络处于代理或VPN环境，请处于直连状态下再开始测试，否则结果没有意义！', {
            confirmText: '坚持测试',
            confirmButtonColor: 'bg-orange-500 hover:bg-orange-600 focus:ring-orange-500',
            cancelText: '取消测试',
            cancelButtonColor: 'bg-green-500 hover:bg-green-600 focus:ring-green-500',
        });
        return result;
    };

    const validateInputs = (): { countNum: number; threadsNum: number; latencyLimitNum: number; lossLimitNum: number; roundsNum: number; timeoutNum: number; topNNum: number; jitterStableNum: number; jitterBackupNum: number } | null => {
        let hasError = false;
        const checkInt = (v: string, setErr: (s: string) => void, msg: string) => {
            if (!/^\d+$/.test(v.trim())) { setErr(msg); hasError = true; } else setErr('');
        };
        if (ipSource !== 'third' && ipSource !== 'domain') checkInt(count, setCountError, '请输入有效的正整数');
        else setCountError('');
        checkInt(threads, setThreadsError, '请输入大于等于1的整数');
        if (/^\d+$/.test(threads.trim()) && parseInt(threads.trim(), 10) < 1) { setThreadsError('请输入大于等于1的整数'); hasError = true; }
        checkInt(latencyLimit, setLatencyLimitError, '请输入有效的正整数');
        checkInt(lossLimit, setLossLimitError, '请输入 0-100 的整数');
        if (/^\d+$/.test(lossLimit.trim()) && parseInt(lossLimit.trim(), 10) > 100) { setLossLimitError('请输入 0-100 的整数'); hasError = true; }
        checkInt(rounds, setRoundsError, '请输入 1-5 的整数');
        if (/^\d+$/.test(rounds.trim()) && (parseInt(rounds.trim(), 10) < 1 || parseInt(rounds.trim(), 10) > 5)) { setRoundsError('请输入 1-5 的整数'); hasError = true; }
        checkInt(timeoutMs, setTimeoutError, '请输入有效的正整数');
        checkInt(topN, setTopNError, '请输入大于等于1的整数');
        const js = parseInt(jitterStable.trim(), 10);
        const jb = parseInt(jitterBackup.trim(), 10);
        if (!/^\d+$/.test(jitterStable.trim()) || !/^\d+$/.test(jitterBackup.trim()) || isNaN(js) || isNaN(jb) || js >= jb) {
            setJitterError('请输入两个正整数，且优先值小于备用值');
            hasError = true;
        } else setJitterError('');
        if (coloFilter.length === 0) {
            showToast('请至少选择一个机房', 'warning');
            hasError = true;
        }
        if (hasError) return null;
        return {
            countNum: parseInt(count.trim(), 10),
            threadsNum: parseInt(threads.trim(), 10),
            latencyLimitNum: parseInt(latencyLimit.trim(), 10),
            lossLimitNum: parseInt(lossLimit.trim(), 10),
            roundsNum: parseInt(rounds.trim(), 10),
            timeoutNum: parseInt(timeoutMs.trim(), 10),
            topNNum: parseInt(topN.trim(), 10),
            jitterStableNum: js,
            jitterBackupNum: jb,
        };
    };

    const checkGeoLocation = async (): Promise<boolean> => {
        let isCN = true;
        try {
            const response = await fetch('https://api.ip.sb/geoip');
            const data = await response.json() as { country_code: string };
            isCN = data.country_code === 'CN';
        } catch (error) {
            console.error('Failed to determine location:', error);
            isCN = false;
        }
        if (!isCN) {
            return showLocationWarning();
        }
        return true;
    };

    /** 域名条目解析出测速 IP（DoH），供本地后端连接；展示与保存仍用域名 */
    const resolveDomainItems = async (items: { host: string; port: number }[]) => {
        const resolvedMap: Record<string, string | null> = {};
        const domainItems = items.filter(i => isDomainName(i.host));
        const entries = await Promise.all(
            domainItems.map(async (i) => [`${i.host}:${i.port}`, await resolveDomainToIp(i.host)] as const)
        );
        for (const [key, ip] of entries) resolvedMap[key] = ip;
        return resolvedMap;
    };

    const prepareTargets = async (countNum: number): Promise<{ targets: string[]; resolvedMap?: Record<string, string | null>; sourceMap?: Record<string, string> } | null> => {
        setSourceRows([]);
        setUniqueIpCount(0);
        setGrossIpCount(0);
        setIpCount(0);
        setDomainCount(0);

        if (cancelPreparingRef.current) return null;

        // ---------- 域名源 ----------
        if (ipSource === 'domain') {
            const items = parseDirectEntries(domainText, selectedPort);
            if (items.length === 0) {
                showToast('域名列表为空，请先点击“导入 BestCF 域名列表”或手动粘贴域名', 'warning');
                return null;
            }
            const targets = items.map(i => `${i.host}:${i.port}`);
            setUniqueIpCount(targets.length);
            setGrossIpCount(targets.length);
            setIpCount(items.filter(i => !isDomainName(i.host)).length);
            setDomainCount(items.filter(i => isDomainName(i.host)).length);
            const resolvedMap = await resolveDomainItems(items);
            const sourceMap: Record<string, string> = {};
            for (const t of targets) sourceMap[t] = '域名源';
            return { targets, resolvedMap, sourceMap };
        }

        // ---------- 第三方源：URL 走后端拉取，直接 IP/域名与本地上传在前端直接解析 ----------
        if (ipSource === 'third') {
            setPrepareDone(0);
            setPrepareTotal(0);

            const sources = await getThirdPartySourceList();
            const directText = [localStorage.getItem(THIRD_DIRECT_KEY) || ''].join('\n');
            // 源列表里非 URL 的行也是直接条目（粘贴的 IP/域名）
            const directLines = (Array.isArray(sources) ? sources : []).filter(s => !/^https?:\/\//i.test(s.trim()));
            const urlSources = (Array.isArray(sources) ? sources : []).filter(s => /^https?:\/\//i.test(s.trim()));
            const directItems = parseDirectEntries([...directLines, directText].join('\n'), selectedPort);

            if (urlSources.length === 0 && directItems.length === 0) {
                showToast('未配置第三方源，请先到"第三方 IP/域名 源"中添加链接、IP 或上传文件', 'warning');
                return null;
            }

            const rows: SourceRow[] = urlSources.map((url) => ({ url, status: 'pending' }));
            setSourceRows(rows);
            setPrepareTotal(urlSources.length);

            const allIps = new Map<string, { ip: string; port: number; sourceLabel: string }>();
            for (const item of directItems) allIps.set(`${item.host}:${item.port}`, { ip: item.host, port: item.port, sourceLabel: '手动粘贴' });
            let grossCount = directItems.length;
            let doneCount = 0;

            for (let i = 0; i < urlSources.length; i++) {
                if (cancelPreparingRef.current) return null;
                setSourceRows((prev) => prev.map((r, idx) => idx === i ? { ...r, status: 'loading' } : r));
                setPrepareDone(i);

                let stat;
                try {
                    stat = await getThirdPartySourceIps(urlSources[i]);
                } catch (e) {
                    stat = { url: urlSources[i], status: 'error', count: 0, ipCount: 0, domainCount: 0, ips: [], error: (e as Error).message };
                }

                setSourceRows((prev) => prev.map((r, idx) => idx === i ? {
                    url: stat.url,
                    status: stat.status === 'error' ? 'error' : 'done',
                    ipCount: stat.ipCount,
                    domainCount: stat.domainCount,
                    error: stat.error,
                    ips: stat.ips
                } : r));
                doneCount++;
                setPrepareDone(doneCount);

                if (stat.status !== 'error') {
                    // 同一 IP:端口出现在多个源里时，第一次出现的源归属保留（先直接粘贴，后按源顺序）
                    const label = urlSources[i].replace(/^https?:\/\//, '');
                    for (const item of stat.ips) {
                        const key = `${item.ip}:${item.port}`;
                        if (!allIps.has(key)) allIps.set(key, { ip: item.ip, port: item.port, sourceLabel: label });
                    }
                }
                grossCount += stat.count;
            }

            if (cancelPreparingRef.current) return null;

            const finalIps = Array.from(allIps.values());
            let dedupIp = 0;
            let dedupDomain = 0;
            for (const item of finalIps) {
                if (isDomainName(item.ip)) dedupDomain++;
                else dedupIp++;
            }

            setUniqueIpCount(finalIps.length);
            setGrossIpCount(grossCount);
            setIpCount(dedupIp);
            setDomainCount(dedupDomain);

            if (finalIps.length === 0) {
                showToast('未能获取到第三方源IP，请检查配置或后台日志', 'warning');
                return null;
            }

            const targets: string[] = [];
            const sourceMap: Record<string, string> = {};
            for (const item of finalIps) {
                const key = `${item.ip}:${item.port}`;
                targets.push(key);
                sourceMap[key] = item.sourceLabel;
            }
            const resolvedMap = await resolveDomainItems(finalIps.map(i => ({ host: i.ip, port: i.port })));
            return { targets, resolvedMap, sourceMap };
        }

        const cidrsToUse = ipSource === 'cf'
            ? (cfIps?.ipv4_cidrs?.length ? cfIps.ipv4_cidrs : (CF_CIDR_LIST || []))
            : (cfIps?.cm_cidrs?.length ? cfIps.cm_cidrs : (CF_CIDR_LIST || []));

        if (!cidrsToUse || cidrsToUse.length === 0) {
            showToast('未找到Cloudflare IP段数据，请先点击上方的"同步IP段"按钮进行同步。', 'error');
            return null;
        }
        const targets = generateRandomIps(cidrsToUse, countNum);
        const sourceLabel = ipSource === 'cf' ? 'CF官方IP段' : 'CM整理IP段';
        const sourceMap: Record<string, string> = {};
        for (const t of targets) sourceMap[t] = sourceLabel;
        return { targets, sourceMap };
    };

    // ---------- 本地后端测速 ----------

    /** 后端结果 -> 页面统一的 ScanResult，从而复用原有的结果列表与保存逻辑。
     *  后端回传的 source 可能是 SourceKind，也可能是每条源的标签；
     *  是标签时拆到 sourceLabel，source 仍保留本次扫描的 SourceKind，
     *  这样结果列表按来源筛选的逻辑不受影响。 */
    const toScanResult = (r: AgentResult, source: SourceKind): ScanResult => {
        const isKind = (v: string | undefined): v is SourceKind =>
            v === 'cf' || v === 'cm' || v === 'domain' || v === 'third';
        return {
            ip: r.host,
            port: r.port,
            isAvailable: r.ok,
            latency: r.ok ? r.latency : -1,
            colo: r.colo || undefined,
            domain: isDomainName(r.host) || undefined,
            tcpMs: r.tcpMs >= 0 ? r.tcpMs : undefined,
            tlsMs: r.tlsMs >= 0 ? r.tlsMs : undefined,
            error: r.error || undefined,
            latencies: r.latencies,
            lossPct: r.lossPct,
            jitterMs: r.jitterMs,
            speedMbps: r.speedMbps,
            source: isKind(r.source) ? r.source : source,
            sourceLabel: isKind(r.source) ? undefined : r.source,
            resolvedIp: r.ip,
        };
    };

    /**
     * 把页面已有的靶标字符串解析成后端需要的 {host, ip, port, source}。
     * 域名源用 DoH 已解析出的 IP 去连接，但 host 保留域名。
     * source 为 prepareTargets 记录的每条源标签（sourceMap），后端原样回传，
     * 用于扫完后的按源汇总；没有记录时不传，后端用 payload 的 source 兜底。
     */
    const buildAgentTargets = (
        rawTargets: string[],
        resolvedMap?: Record<string, string | null>,
        defaultPort = 443,
        sourceMap?: Record<string, string>,
    ) => rawTargets.map((raw) => {
        let host = raw;
        let port = defaultPort;
        const lastColon = raw.lastIndexOf(':');
        const closeBracket = raw.lastIndexOf(']');
        if (lastColon > -1 && lastColon > closeBracket) {
            const p = parseInt(raw.substring(lastColon + 1), 10);
            if (!isNaN(p)) {
                port = p;
                host = raw.substring(0, lastColon);
                if (host.startsWith('[') && host.endsWith(']')) host = host.substring(1, host.length - 1);
            }
        }
        if (port === 0) port = 443;
        const ip = (resolvedMap && resolvedMap[raw]) || host;
        return { host, ip, port, source: sourceMap?.[raw] };
    });

    /** 通过本地后端执行测速：下发参数 -> 轮询进度 -> 只汇总达标结果
     *  进度口径：progress = 后端已测完的目标数（p.done），不是达标数；
     *  成功 = 达标数，失败 = 已测数 - 达标数。否则后端测了几百个都没达标时
     *  页面一直显示 0%，看着像卡死了。 */
    const runAgentScan = async (
        targets: { host: string; ip: string; port: number; source?: string }[],
        val: NonNullable<ReturnType<typeof validateInputs>>,
        onProgress: (r: ScanResult) => void,
        onComplete: (rs: ScanResult[]) => void,
        onDone?: (done: number) => void,
        onSummary?: (allQualified: ScanResult[]) => void,
    ) => {
        if (!agentProbe?.online) throw new Error('本地后端未连接');
        const base = agentProbe.baseUrl;

        await startAgentScan(base, {
            targets,
            threads: val.threadsNum,
            timeoutMs: val.timeoutNum,
            latencyLimit: val.latencyLimitNum,
            source: ipSource,
            probeHost: probeHost.trim() || undefined,
            rounds: val.roundsNum,
            lossLimit: val.lossLimitNum,
            jitterStable: val.jitterStableNum,
            jitterBackup: val.jitterBackupNum,
            scanMode,
            portMode,
            coloFilter,
            topN: val.topNNum,
            speedUrl: speedUrl.trim() || 'auto',
        });

        let since = 0;
        let lastDone = -1;
        let stallTicks = 0;
        const acc: ScanResult[] = [];

        while (!agentStopRef.current) {
            const p = await fetchAgentProgress(base, since);
            since += p.count;
            for (const r of p.results) {
                const sr = toScanResult(r, ipSource);
                acc.push(sr);
                onProgress(sr);
            }
            // 每次轮询都把后端已测数推给页面，哪怕本轮没有新增达标结果
            onDone?.(p.done);

            if (!p.running) break;

            // 卡死保护：连续 60 秒没有任何进展则放弃
            if (p.done === lastDone) {
                if (++stallTicks > 150) throw new Error('本地后端长时间无进展，已放弃等待');
            } else {
                lastDone = p.done;
                stallTicks = 0;
            }
            await new Promise((r) => setTimeout(r, 400));
        }

        // 后端只回传达标结果，前端按同一口径再过滤一次，按延迟取前 topN 条。
        // 汇总用不过滤、不截取的全部达标结果（onSummary），否则 topN 会把
        // 每源可用数算少；onComplete 仍只拿截取后的前 topN 条去展示。
        const qualifiedAll = acc
            .filter((r) => isQualified(r, { latencyLimit: val.latencyLimitNum, lossLimit: val.lossLimitNum }));
        onSummary?.(qualifiedAll);
        const qualified = [...qualifiedAll]
            .sort((a, b) => a.latency - b.latency)
            .slice(0, val.topNNum);
        onComplete(qualified);
    };

    const handleScan = async () => {
        cancelPreparingRef.current = false;

        const val = validateInputs();
        if (!val) return;

        // 本地测速是唯一测速方式：后端未连接时不开始，不走浏览器测速
        if (!agentProbe?.online) {
            showToast('本地后端未连接，请先启动本地后端并点击“检测服务”', 'error');
            return;
        }

        setIsPreparing(true);
        try {
            // Step 1: 地理定位检测
            const shouldContinue = await checkGeoLocation();
            if (!shouldContinue || cancelPreparingRef.current) {
                setIsPreparing(false);
                return;
            }

            // Step 2: 准备靶标 IP
            const prepared = await prepareTargets(val.countNum);
            if (!prepared || prepared.targets.length === 0 || cancelPreparingRef.current) {
                setIsPreparing(false);
                return;
            }
            const targets = prepared.targets;

            // Step 3: 初始化扫描状态
            setProgress(0);
            setSuccessCount(0);
            setFailCount(0);
            qualifiedCountRef.current = 0;
            setLastScanSummary(null);
            setTotal(targets.length);
            await new Promise(resolve => setTimeout(resolve, 0));

            const currentResults: ScanResult[] = [];
            // onProgress 只在有新增达标结果时触发：只计成功数
            const onProgress = (result: ScanResult) => {
                currentResults.push(result);
                if (result.isAvailable) {
                    qualifiedCountRef.current += 1;
                    setSuccessCount(qualifiedCountRef.current);
                }
            };
            // onDone 由后端 done 驱动：进度 = 已测数，失败 = 已测数 - 达标数
            const onDone = (done: number) => {
                setProgress(done);
                setFailCount(Math.max(0, done - qualifiedCountRef.current));
            };

            const onComplete = (finalResults: ScanResult[]) => {
                setIsStopping(false);
                agentStopRef.current = false;
                setIsScanning(false);
                setStartTime(null);
                onScanComplete(finalResults);
            };

            // Step 4: 启动本地后端扫描
            setIsPreparing(false);
            setIsScanning(true);
            setStartTime(Date.now());
            setNow(Date.now());

            agentStopRef.current = false;

            const agentTargets = buildAgentTargets(
                targets,
                prepared.resolvedMap,
                ipSource === 'third' || ipSource === 'domain' ? 0 : selectedPort,
                prepared.sourceMap,
            );
            // 按源汇总：tested 按下发目标的 source 标签统计（按首次出现顺序排），
            // qualified 按全部达标结果（不过滤、不截取）的 sourceLabel 统计；
            // 同一 IP:端口出现在多个源时，每个源的可用数都算，去重后总数只算一次。
            const onSummary = (allQualified: ScanResult[]) => {
                const testedByLabel = new Map<string, number>();
                const order: string[] = [];
                for (const t of agentTargets) {
                    const label = t.source || '未知来源';
                    if (!testedByLabel.has(label)) { testedByLabel.set(label, 0); order.push(label); }
                    testedByLabel.set(label, testedByLabel.get(label)! + 1);
                }
                const qualifiedByLabel = new Map<string, number>();
                const seen = new Set<string>();
                let dedup = 0;
                for (const r of allQualified) {
                    const label = r.sourceLabel || (r.source ? SOURCE_LABELS[r.source] : undefined) || '未知来源';
                    qualifiedByLabel.set(label, (qualifiedByLabel.get(label) ?? 0) + 1);
                    const key = `${r.ip}:${r.port}`;
                    if (!seen.has(key)) { seen.add(key); dedup++; }
                }
                for (const label of qualifiedByLabel.keys()) {
                    if (!testedByLabel.has(label)) { testedByLabel.set(label, 0); order.push(label); }
                }
                setLastScanSummary({
                    totalTested: agentTargets.length,
                    totalQualified: allQualified.length,
                    dedupQualified: dedup,
                    perSource: order.map(label => ({
                        label,
                        tested: testedByLabel.get(label) ?? 0,
                        qualified: qualifiedByLabel.get(label) ?? 0,
                    })),
                });
            };
            await runAgentScan(agentTargets, val, onProgress, onComplete, onDone, onSummary);
        } catch (error) {
            console.error('Scan failed:', error);
            setIsScanning(false);
            setIsPreparing(false);
            setStartTime(null);
            showToast('启动测试失败，请检查控制台错误信息', 'error');
        }
    };

    const handleStopScan = () => {
        setIsStopping(true);
        setStartTime(null);
        if (agentProbe?.online) {
            // 轮询循环会自行退出并触发 onComplete 收尾
            agentStopRef.current = true;
            void stopAgentScan(agentProbe.baseUrl);
        }
    };

    // 扫描进行中时，每 1 秒刷新 now 以更新已用时间
    useEffect(() => {
        if (!isScanning) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [isScanning]);

    const sourceBtn = (key: SourceKind, label: string) => (
        <button
            key={key}
            onClick={() => setIpSource(key)}
            disabled={isScanning || isPreparing}
            className={`relative z-10 rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${
                ipSource === key
                    ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                    : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
            }`}
        >
            {label}
        </button>
    );

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-3 mb-4">
                <Gauge className="w-7 h-7 text-purple-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">IP优选测速</h2>
                <span className="px-2 py-0.5 text-xs rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">本地测速</span>
            </div>

            <div className="flex items-center mb-4">
                <label className="text-gray-700 dark:text-gray-300 font-semibold mr-3">IP来源:</label>
                <div className="relative flex w-fit items-center rounded-lg bg-gray-100 p-1 dark:bg-gray-700">
                    {sourceBtn('cf', 'CF官方IP')}
                    {sourceBtn('cm', 'CM整理IP')}
                    {sourceBtn('domain', '域名源')}
                    {sourceBtn('third', '第三方IP/域名源')}
                </div>
            </div>

            {/* ---------- 域名源：BestCF cf_domains.txt 一键导入，或手动粘贴 ---------- */}
            {ipSource === 'domain' && (
                <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-600 p-4">
                    <div className="flex flex-wrap items-center gap-3 mb-2">
                        <span className="text-sm font-bold text-gray-700 dark:text-gray-200">域名列表</span>
                        <button
                            onClick={handleImportBestCfDomains}
                            disabled={importingDomains || isScanning || isPreparing}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-100 rounded-full hover:bg-indigo-200 dark:bg-indigo-900/50 dark:text-indigo-300 dark:hover:bg-indigo-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <Download className="w-3.5 h-3.5" />
                            {importingDomains ? '导入中...' : '导入 BestCF 域名列表'}
                        </button>
                        <span className="text-xs text-gray-400 dark:text-gray-500">已填 {domainEntries.length} 个域名</span>
                    </div>
                    <textarea
                        value={domainText}
                        onChange={(e) => {
                            setDomainText(e.target.value);
                            try { localStorage.setItem(DOMAIN_LIST_KEY, e.target.value); } catch { /* 忽略 */ }
                        }}
                        placeholder={'每行一个域名，可带端口，例如：\ndash.cloudflare.com\nexample.com:8443'}
                        rows={5}
                        disabled={isScanning || isPreparing}
                        className="w-full p-3 border rounded-md text-sm font-mono dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:ring-2 focus:ring-purple-500 outline-none resize-y disabled:opacity-50"
                    />
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">域名先解析出 IP 再由本地后端测速，展示与保存仍用域名。</p>
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                <div>
                    <label htmlFor="ip-count" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">随机IP数量:</label>
                    <input
                        id="ip-count"
                        type="text"
                        value={count}
                        onChange={(e) => { setCount(e.target.value); if (countError) setCountError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing || ipSource === 'third' || ipSource === 'domain'}
                    />
                    {countError && <p className="text-red-500 text-xs mt-1">{countError}</p>}
                </div>
                <div>
                    <label htmlFor="port-select" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">端口:</label>
                    <select id="port-select" value={portSelectValue} onChange={(e) => {
                        if (e.target.value === 'random') setPortMode('random');
                        else { setPortMode('fixed'); setSelectedPort(Number(e.target.value)); }
                    }} className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50" disabled={isScanning || isPreparing}>
                        {CF_PORTS.map(port => (
                            <option key={port} value={port}>{port}</option>
                        ))}
                        <option value="random">随机</option>
                    </select>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">固定端口或随机（443 / 2053 / 2083 / 2087 / 2096 / 8443）</p>
                </div>
                <div>
                    <label htmlFor="threads-count" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">线程数:</label>
                    <input
                        id="threads-count"
                        type="text"
                        value={threads}
                        onChange={(e) => { setThreads(e.target.value); if (threadsError) setThreadsError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {threadsError && <p className="text-red-500 text-xs mt-1">{threadsError}</p>}
                </div>
                <div>
                    <label htmlFor="latency-limit" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">延迟限制(ms):</label>
                    <input
                        id="latency-limit"
                        type="text"
                        value={latencyLimit}
                        onChange={(e) => { setLatencyLimit(e.target.value); if (latencyLimitError) setLatencyLimitError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {latencyLimitError && <p className="text-red-500 text-xs mt-1">{latencyLimitError}</p>}
                </div>
                <div>
                    <label htmlFor="loss-limit" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">丢包上限(%):</label>
                    <input
                        id="loss-limit"
                        type="text"
                        value={lossLimit}
                        onChange={(e) => { setLossLimit(e.target.value); if (lossLimitError) setLossLimitError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {lossLimitError && <p className="text-red-500 text-xs mt-1">{lossLimitError}</p>}
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">3 次均须达标</p>
                </div>
                <div>
                    <label htmlFor="rounds" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">测速轮次:</label>
                    <input
                        id="rounds"
                        type="text"
                        value={rounds}
                        onChange={(e) => { setRounds(e.target.value); if (roundsError) setRoundsError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {roundsError && <p className="text-red-500 text-xs mt-1">{roundsError}</p>}
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">每次测 3 次，取最好一次</p>
                </div>
                <div>
                    <label htmlFor="jitter-stable" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">抖动优先(ms):</label>
                    <input
                        id="jitter-stable"
                        type="text"
                        value={jitterStable}
                        onChange={(e) => { setJitterStable(e.target.value); if (jitterError) setJitterError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                </div>
                <div>
                    <label htmlFor="jitter-backup" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">抖动备用(ms):</label>
                    <input
                        id="jitter-backup"
                        type="text"
                        value={jitterBackup}
                        onChange={(e) => { setJitterBackup(e.target.value); if (jitterError) setJitterError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {jitterError && <p className="text-red-500 text-xs mt-1">{jitterError}</p>}
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">≤优先值优先，≤备用值备用，超过降级</p>
                </div>
                <div>
                    <label htmlFor="timeout-ms" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">超时(ms):</label>
                    <input
                        id="timeout-ms"
                        type="text"
                        value={timeoutMs}
                        onChange={(e) => { setTimeoutMs(e.target.value); if (timeoutError) setTimeoutError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {timeoutError && <p className="text-red-500 text-xs mt-1">{timeoutError}</p>}
                </div>
                <div>
                    <label htmlFor="top-n" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">输出数量:</label>
                    <input
                        id="top-n"
                        type="text"
                        value={topN}
                        onChange={(e) => { setTopN(e.target.value); if (topNError) setTopNError(''); }}
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    {topNError && <p className="text-red-500 text-xs mt-1">{topNError}</p>}
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">按延迟排序取前 N 条</p>
                </div>
                <div>
                    <label htmlFor="speed-url" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">测速地址:</label>
                    <input
                        id="speed-url"
                        type="text"
                        value={speedUrl}
                        onChange={(e) => setSpeedUrl(e.target.value)}
                        placeholder="auto"
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">auto 为后端自动选择</p>
                </div>
                <div>
                    <label className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">扫描方式:</label>
                    <div className="flex w-fit items-center rounded-lg bg-gray-100 p-1 dark:bg-gray-700">
                        <button
                            type="button"
                            onClick={() => setScanMode('tcping')}
                            disabled={isScanning || isPreparing}
                            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${scanMode === 'tcping' ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white' : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'}`}
                        >
                            TCPing
                        </button>
                        <button
                            type="button"
                            onClick={() => setScanMode('httping')}
                            disabled={isScanning || isPreparing}
                            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${scanMode === 'httping' ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white' : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'}`}
                        >
                            HTTPing
                        </button>
                    </div>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">TCPing 为 TCP 握手延迟，HTTPing 为 TTFB</p>
                </div>
                <div>
                    <label htmlFor="probe-host" className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">探针域名:</label>
                    <input
                        id="probe-host"
                        type="text"
                        value={probeHost}
                        onChange={(e) => setProbeHost(e.target.value)}
                        placeholder="如 jpagxr.sidns.xyz，留空则用 speed.cloudflare.com"
                        className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 dark:text-white dark:bg-gray-700 dark:border-gray-600 leading-tight focus:outline-none focus:shadow-outline disabled:opacity-50"
                        disabled={isScanning || isPreparing}
                    />
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">填节点域名，后端用它当 SNI 探针，通不了的优选 IP 直接筛掉；留空则用 speed.cloudflare.com</p>
                </div>
            </div>

            {/* 机房筛选：常用机房全有（亚洲 + 美国 + 欧洲），默认只勾亚洲 5 个 */}
            <div className="mb-4">
                <label className="block text-gray-700 dark:text-gray-300 text-sm font-bold mb-1">机房筛选:</label>
                <div className="space-y-2">
                    {([['亚洲', ASIAN_COLOS], ['美国', US_COLOS], ['欧洲', EU_COLOS]] as const).map(([region, colos]) => (
                        <div key={region} className="flex flex-wrap items-center gap-2">
                            <span className="w-10 text-xs font-medium text-gray-500 dark:text-gray-400">{region}</span>
                            {colos.map(colo => {
                                const checked = coloFilter.includes(colo);
                                return (
                                    <label key={colo} className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-full border cursor-pointer transition-colors ${checked ? 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60' : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'}`}>
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={isScanning || isPreparing}
                                            onChange={() => setColoFilter(prev => prev.includes(colo) ? prev.filter(c => c !== colo) : [...prev, colo])}
                                            className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                        />
                                        {colo}
                                    </label>
                                );
                            })}
                        </div>
                    ))}
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">共 {COMMON_COLOS.length} 个常用机房，默认只勾亚洲 5 个，需要时再勾其他机房</p>
            </div>

            {/* ============ 本地后端 ============ */}
            <div className="mb-4">
                <div className={'rounded-lg border overflow-hidden ' + (agentProbe?.online ? 'border-green-500 dark:border-green-500' : 'border-red-500 dark:border-red-500')}>
                    <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-900/40">
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            <Cpu className="w-5 h-5 text-teal-500 flex-none" />
                            <span className="font-medium text-gray-700 dark:text-gray-200">本地后端测速</span>
                            {agentProbe === null && (
                                <span className="px-2 py-0.5 text-xs rounded-full bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300">未检测</span>
                            )}
                            {agentProbe && !agentProbe.online && agentProbe.reason === 'offline' && (
                                <span className="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">未启动</span>
                            )}
                            {agentProbe?.online && (
                                <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                                    已连接 {agentProbe.baseUrl}
                                    {agentProbe.status.running && agentProbe.status.task
                                        ? ` · 忙（${agentProbe.status.task.done}/${agentProbe.status.task.total}）`
                                        : ''}
                                </span>
                            )}
                        </div>

                        <button
                            onClick={() => void checkAgent(Number(agentPort) || DEFAULT_AGENT_PORT)}
                            disabled={agentChecking || isScanning}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-teal-600 text-white hover:bg-teal-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-none"
                        >
                            <RefreshCw className={`w-3 h-3 ${agentChecking ? 'animate-spin' : ''}`} />
                            {agentChecking ? '检测中' : '检测服务'}
                        </button>
                    </div>

                    <div className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-3">
                            <label htmlFor="agent-port" className="text-xs text-gray-600 dark:text-gray-400 flex-none">本地服务端口</label>
                            <input
                                id="agent-port"
                                type="text"
                                inputMode="numeric"
                                value={agentPort}
                                onChange={(e) => {
                                    const v = e.target.value.replace(/[^\d]/g, '').slice(0, 5);
                                    setAgentPort(v);
                                    localStorage.setItem('LOCAL_AGENT_PORT', v);
                                }}
                                placeholder={String(DEFAULT_AGENT_PORT)}
                                className="w-24 px-2.5 py-1.5 text-xs font-mono rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-teal-500 focus:border-transparent outline-none disabled:opacity-50"
                                disabled={isScanning || agentChecking}
                            />
                            <span className="text-xs text-gray-400 dark:text-gray-500">默认 {DEFAULT_AGENT_PORT}（旧版 Agent 15888 仍可探测）</span>
                        </div>

                        {!agentProbe?.online && (
                            <>
                                <p className="text-sm text-gray-600 dark:text-gray-300 mb-2">
                                    本机后端未运行，请按以下步骤启动：
                                </p>
                                <ol className="list-decimal list-inside space-y-1.5 text-sm text-gray-600 dark:text-gray-400 mb-3">
                                    <li>运行本地后端程序（CFData-Web，Go 单文件，双击即可启动）</li>
                                    <li>确认监听 127.0.0.1:{DEFAULT_AGENT_PORT}，再点「检测服务」</li>
                                    <li>后端按页面参数执行测速，只把达标结果回传到前端展示</li>
                                </ol>
                            </>
                        )}
                    </div>
                </div>
            </div>

            <div className="mb-4 flex justify-center" >
                <button onClick={handleScan} disabled={isScanning || isPreparing || !agentProbe?.online} className="flex items-center bg-purple-600 text-white font-bold py-2 px-4 rounded-md hover:bg-purple-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed">
                    {isPreparing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                    {isPreparing
                        ? (ipSource === 'third' && prepareTotal > 0
                            ? `解析源 ${prepareDone}/${prepareTotal}`
                            : '准备中...')
                            : isScanning
                                ? `测试中... (${progress}/${total})`
                                : (agentProbe?.online ? '开始测试（本地）' : '本地后端未连接')}
                </button>
                {isPreparing && (
                    <button onClick={() => { cancelPreparingRef.current = true; setIsPreparing(false); }} style={{ marginLeft: "8px" }}
                            className="flex items-center bg-red-600 text-white font-bold py-2 px-4 rounded-md hover:bg-red-700 transition-colors">
                        <StopCircle className="w-4 h-4 mr-2" />
                        取消准备
                    </button>
                )}
                {isScanning && (
                    <button onClick={handleStopScan} style={{ marginLeft: "8px" }} disabled={isStopping}
                            className="flex items-center bg-red-600 text-white font-bold py-2 px-4 rounded-md hover:bg-red-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed">
                        <StopCircle className="w-4 h-4 mr-2" />
                        {isStopping ? '停止中...' : '停止测试'}
                    </button>
                )}
            </div >

            {/* 第三方源逐条解析展示区 */}
            {ipSource === 'third' && sourceRows.length > 0 && (
                <div className="mb-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 border border-gray-100 dark:border-gray-700">
                    <h3 className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                        第三方IP/域名获取详情 {isPreparing && `(${prepareDone}/${prepareTotal})`}
                    </h3>

                    {/* 解析完成后的总览信息 */}
                    {!isPreparing && (
                        <div className="mb-3 text-sm text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800/50 p-2 rounded-md text-center">
                            共发现 <strong className="text-blue-500 font-semibold">{grossIpCount}</strong> 个记录，
                            去重后剩余 <strong className="text-purple-500 font-semibold">{uniqueIpCount}</strong> 个，
                            其中 IP <strong className="text-green-500 font-semibold">{ipCount}</strong> 个、
                            域名 <strong className="text-orange-500 font-semibold">{domainCount}</strong> 个。
                        </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {sourceRows.map((row, idx) => (
                            <div key={idx} className="flex items-center justify-between bg-white dark:bg-gray-800 p-2 rounded border border-gray-100 dark:border-gray-600 shadow-sm text-xs transition-colors hover:border-purple-200 dark:hover:border-purple-800">
                                <div className="truncate flex-1 mr-2 text-gray-600 dark:text-gray-300 font-mono" title={row.url}>
                                    {row.url.replace(/^https?:\/\//, '')}
                                </div>
                                <span className="flex items-center gap-1 shrink-0">
                                    {row.status === 'pending' && (
                                        <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                                            等待中
                                        </span>
                                    )}
                                    {row.status === 'loading' && (
                                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full font-bold shadow-sm bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            解析中
                                        </span>
                                    )}
                                    {row.status === 'done' && (
                                        <>
                                            {row.ipCount! > 0 && (
                                                <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" title="IP 个数">
                                                    IP {row.ipCount}
                                                </span>
                                            )}
                                            {row.domainCount! > 0 && (
                                                <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" title="域名个数">
                                                    域名 {row.domainCount}
                                                </span>
                                            )}
                                            {row.ipCount === 0 && row.domainCount === 0 && (
                                                <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400" title="该源未返回有效条目">
                                                    未解析出
                                                </span>
                                            )}
                                        </>
                                    )}
                                    {row.status === 'error' && (
                                        <span className="px-2 py-0.5 rounded-full font-bold shadow-sm bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" title={row.error || '请求失败'}>
                                            失败
                                        </span>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 本次扫描汇总：扫完后持久显示，不随进度浮窗消失 */}
            {lastScanSummary && (
                <div className="mb-4 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700/50 p-4">
                    <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-2">本次扫描汇总</h3>
                    <div className="space-y-1 text-sm text-gray-600 dark:text-gray-300">
                        {lastScanSummary.perSource.map((row) => (
                            <div key={row.label} className="flex justify-between gap-2">
                                <span className="font-mono truncate" title={row.label}>{row.label}</span>
                                <span className="shrink-0">测 {row.tested} 个，可用 <strong className="text-green-600">{row.qualified}</strong> 个</span>
                            </div>
                        ))}
                    </div>
                    <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-600 text-sm text-gray-700 dark:text-gray-200">
                        去重后可用：<strong className="text-green-600">{lastScanSummary.dedupQualified}</strong> 个 / 共测 {lastScanSummary.totalTested} 个
                    </div>
                </div>
            )}

            {isScanning && (() => {
                const elapsedSec = startTime ? Math.floor((now - startTime) / 1000) : 0;
                const percent = total > 0 ? Math.round((progress / total) * 100) : 0;
                const fmt = (s: number) => {
                    const m = Math.floor(s / 60);
                    const sec = s % 60;
                    return `${m}:${sec.toString().padStart(2, '0')}`;
                };
                return (
                    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 w-[calc(100%-2rem)] max-w-xl px-5 py-3 rounded-xl bg-white/95 dark:bg-gray-800/95 backdrop-blur border border-gray-200 dark:border-gray-700 shadow-[0_-4px_16px_rgba(0,0,0,0.12)]">
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-base font-medium text-purple-700 dark:text-white">
                                进度 {percent}%
                            </span>
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-purple-700 dark:text-white mr-1">
                                    任务: {progress} / {total}
                                </span>
                                <button
                                    type="button"
                                    onClick={handleStopScan}
                                    disabled={isStopping}
                                    aria-label="停止测试"
                                    title="停止测试"
                                    className="p-1.5 rounded-full text-red-600 bg-red-100 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Square className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        <div className="w-full flex h-2.5 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700">
                            <div className="bg-green-500 h-2.5 transition-all duration-300" style={{ width: `${total > 0 ? (successCount / total) * 100 : 0}%` }}></div>
                            <div className="bg-red-500 h-2.5 transition-all duration-300" style={{ width: `${total > 0 ? (failCount / total) * 100 : 0}%` }}></div>
                        </div>
                        <div className="flex justify-between text-sm mt-1">
                            <span className="text-green-600">达标: {successCount}</span>
                            <span className="text-gray-500 dark:text-gray-400">已用: {fmt(elapsedSec)}</span>
                            <span className="text-red-600">未达标: {failCount}</span>
                        </div>
                    </div>
                );
            })()}
        </div >
    );
}
