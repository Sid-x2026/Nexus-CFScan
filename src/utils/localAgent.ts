/**
 * 本地后端服务客户端（CFData-Web 思路的 Go 本地后端）
 * ------------------------------------------------------------------
 * 网页直接连本机 127.0.0.1 上的本地后端下发测速任务、轮询进度、取回结果，
 * 不经任何服务端中转，因此页面上的参数可以原样下发给本机执行。
 *
 * 后端只回传达标结果：延迟 3 次取最好一次 ≤ 延迟上限，且丢包 ≤ 丢包上限；
 * 前端只展示后端回传的达标结果，并按同一口径再做一次兜底过滤。
 *
 * 网页与本地服务之间无需令牌：localhost / 127.0.0.1 仅本机可达，不存在
 * 跨网络泄露风险。
 *
 * 浏览器兼容性说明：
 *   HTTPS 页面请求 http://127.0.0.1 属于"混合内容"，但 W3C 规范与
 *   Chrome / Edge / Firefox 均把 localhost 与 127.0.0.1 视为
 *   "潜在可信来源"，对此类请求放行。Safari 较严格，若被拦截，
 *   可改用 http 方式访问本站点。
 */

import type { SourceKind } from './scanner';

/** 本地后端默认端口（CFData-Web Go 本地后端，默认 13335） */
export const DEFAULT_AGENT_PORT = 13335;
/** 兼容旧版本地 Agent（Node，默认 15888）：13335 未命中时再探测它 */
export const LEGACY_AGENT_PORT = 15888;

/** 探测时向后尝试的端口数量（服务端口被占用会自动 +1，故多探几个以保证命中） */
const PROBE_PORT_RANGE = 10;

export interface AgentStatus {
    ok: boolean;
    service?: string;
    version?: string;
    agentId?: string;
    running: boolean;
    task: { taskId: string; done: number; total: number; startedAt: number } | null;
}

export interface AgentResult {
    host: string;   // 展示用（域名源时为域名）
    ip: string;     // 实际连接的 IP
    port: number;
    tcpMs: number;
    tlsMs: number;
    /** 最好一次延迟（3 次取最小），即达标判定用的延迟 */
    latency: number;
    colo: string;
    loc: string;
    ok: boolean;
    error: string;
    status: number;
    ts: number;
    /** 3 次实测延迟（按测速轮次顺序） */
    latencies?: number[];
    /** 丢包率（%），失败次数 / 测速轮次 */
    lossPct?: number;
    /** 抖动（ms），3 次延迟的最大值 - 最小值 */
    jitterMs?: number;
    /** 入选后测速速率（MB/s），未测速时为空 */
    speedMbps?: number;
    /** 结果来源：cf / cm / domain / third */
    source?: SourceKind;
}

export interface AgentProgress {
    ok: boolean;
    taskId: string | null;
    running: boolean;
    done: number;
    total: number;
    since: number;
    count: number;
    results: AgentResult[];
    startedAt: number;
    finishedAt: number;
}

/**
 * 下发给本地后端的测速参数（直接取自页面上的配置）。
 * 字段与 CFData-Web 的参数思路对应：扫描方式、端口、并发、延迟阈值、
 * 测速地址、链路复验均可配置；rounds / lossLimit / jitter* / coloFilter /
 * topN 为本次新增的达标判定参数，后端按此判定，只回传达标结果。
 */
export interface AgentScanPayload {
    targets: { host: string; ip: string; port: number }[];
    threads: number;
    timeoutMs: number;
    latencyLimit: number;
    sni?: string;
    httpHost?: string;
    source?: SourceKind;
    /** 测速轮次，默认 3 */
    rounds?: number;
    /** 丢包上限（%），3 次均须达标，默认 10 */
    lossLimit?: number;
    /** 抖动分档上限（ms）：≤ jitterStable 优先，≤ jitterBackup 备用，超过降级 */
    jitterStable?: number;
    jitterBackup?: number;
    /** 扫描方式：tcping（TCP 握手延迟）或 httping（HTTP TTFB） */
    scanMode?: 'tcping' | 'httping';
    /** 端口模式：fixed 固定端口，random 从 CF_PORTS 中随机 */
    portMode?: 'fixed' | 'random';
    /** 机房筛选，默认仅亚洲 HKG/NRT/SIN/ICN/TPE */
    coloFilter?: string[];
    /** 输出数量，按延迟排序取前 N 条，默认 20 */
    topN?: number;
    /** 测速地址，'auto' 为后端自动选择 */
    speedUrl?: string;
}

export type AgentProbeResult =
    | { online: true; baseUrl: string; status: AgentStatus }
    | { online: false; reason: 'offline' | 'occupied' };

// ==================================================================
// 基础请求封装
// ==================================================================
async function agentFetch(
    baseUrl: string,
    path: string,
    init: RequestInit = {},
    timeoutMs = 4000
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(init.headers as Record<string, string> | undefined),
        };
        return await fetch(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ==================================================================
// 探测本地服务是否在线
// ==================================================================
export async function probeLocalAgent(port: number = DEFAULT_AGENT_PORT): Promise<AgentProbeResult> {
    // 从用户设置的端口开始，依次向后探测（服务端口被占用会自动 +1）；
    // 未命中再探测旧版 Agent 端口，保证过渡期旧后端仍可用。
    const startPorts = [port, LEGACY_AGENT_PORT];
    for (const start of startPorts) {
        const attempts = Array.from({ length: PROBE_PORT_RANGE }, (_, i) => start + i).map(async (p) => {
            const baseUrl = `http://127.0.0.1:${p}`;
            try {
                const res = await agentFetch(baseUrl, '/status', { method: 'GET' }, 2500);
                if (!res.ok) return null;
                const status = (await res.json()) as AgentStatus;
                // 接受新版 CFData-Web 后端与旧版 Agent：只要返回了可识别的状态
                if (!status || (status.service !== 'kgcfip-agent' && status.service !== 'cfdata' && status.running === undefined)) return null;
                return { baseUrl, status };
            } catch {
                return null;
            }
        });

        const settled = await Promise.all(attempts);
        const hit = settled.find((x): x is { baseUrl: string; status: AgentStatus } => !!x);
        if (hit) return { online: true, baseUrl: hit.baseUrl, status: hit.status };
    }

    return { online: false, reason: 'offline' };
}

// ==================================================================
// 下发 / 轮询 / 停止
// ==================================================================
export async function startAgentScan(
    baseUrl: string,
    payload: AgentScanPayload
): Promise<{ taskId: string; total: number }> {
    const res = await agentFetch(baseUrl, '/scan', {
        method: 'POST',
        body: JSON.stringify(payload),
    }, 10000);

    const data = await res.json().catch(() => ({})) as {
        ok?: boolean; error?: string; taskId?: string; total?: number;
    };
    if (res.status === 409) throw new Error('本地后端正在执行其它任务，请等待完成或先停止');
    if (!res.ok || !data.ok) throw new Error(data.error || `下发任务失败（HTTP ${res.status}）`);
    if (!data.taskId) throw new Error('本地后端未返回任务 ID');
    return { taskId: data.taskId, total: data.total ?? payload.targets.length };
}

export async function fetchAgentProgress(
    baseUrl: string,
    since: number
): Promise<AgentProgress> {
    const res = await agentFetch(baseUrl, `/progress?since=${since}`, { method: 'GET' }, 6000);
    if (!res.ok) throw new Error(`读取进度失败（HTTP ${res.status}）`);
    return (await res.json()) as AgentProgress;
}

export async function stopAgentScan(baseUrl: string): Promise<void> {
    try {
        await agentFetch(baseUrl, '/stop', { method: 'POST' }, 3000);
    } catch {
        // 停止失败不影响前端收尾
    }
}
