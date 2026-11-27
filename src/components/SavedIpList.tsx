import { useState, useEffect, useMemo, useRef } from 'react';
import { getScenes, getSceneResults, saveResults, deleteScene } from '../api';
import { getLatencyColor, ScanResult, SOURCE_LABELS, DEFAULT_SCAN_PARAMS } from '../utils/scanner';
import {
    probeLocalAgent, probeSingle, speedSingle, latencySingle, DEFAULT_AGENT_PORT, AGENT_BUSY_ERROR,
    type SingleProbeResult, type SingleSpeedResult, type SingleLatencyResult,
} from '../utils/localAgent';
import { getColoName } from '../utils/colo';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog'; // Import Trash2 and RotateCw
import { ListChecks, Trash2, RotateCw, FileText, File, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { RegionDisplay } from './RegionDisplay';

/** 与 ScannerConfig 的扫描参数共用同一个 localStorage 键：测延迟沿用其中的轮次/超时/方式 */
const SCAN_PARAMS_KEY = 'CF_SCAN_PARAMS';

/** 与 ScannerConfig 的探针域名输入框共用同一个 localStorage 键 */
const PROBE_HOST_KEY = 'CF_PROBE_HOST';

// Type for data stored in KV, which does not include `isAvailable`
interface SavedIpData {
    ip: string;
    port: number;
    latency: number;
    colo?: string;
    domain?: boolean; // 是否为域名源
    latencies?: number[];
    lossPct?: number;
    jitterMs?: number;
    speedMbps?: number;
    source?: 'cf' | 'cm' | 'domain' | 'third';
    /** 域名源解析出的实际连接 IP（保存时随结果一起存入） */
    resolvedIp?: string;
}
interface FlatIpItem extends SavedIpData {
    sceneName: string;
}

export function SavedIpList() {
    const [items, setItems] = useState<FlatIpItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedScenes, setSelectedScenes] = useState<Set<string>>(new Set());
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    /** 场景管理面板是否展开：列出每个场景的名字和个数，可直接删除场景 */
    const [showSceneManage, setShowSceneManage] = useState(false);
    /** 地区筛选：下拉选一个机房代码（NRT/HKG/ICN…），只看该地区的 IP；'all' 为全部 */
    const [selectedRegion, setSelectedRegion] = useState<string>('all');
    /** 表头排序：点一下按该列升序，再点一下降序；默认按延迟升序（和原来一致） */
    type SortKey = 'ip' | 'port' | 'latency' | 'lossPct' | 'jitterMs' | 'speedMbps' | 'colo' | 'scene';
    const [sortKey, setSortKey] = useState<SortKey>('latency');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
    const toggleSort = (key: SortKey) => {
        if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        else {
            setSortKey(key);
            setSortDir('asc');
        }
    };
    const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
    /** 延迟上限筛选：只显示延迟 ≤ 该值的 IP（高于该值的不显示）；留空为不过滤，值记在浏览器里 */
    const [latencyMax, setLatencyMax] = useState<string>(() => {
        try { return localStorage.getItem('CF_SAVED_LATENCY_MAX') || ''; } catch { return ''; }
    });
    /** 下载速度下限筛选：只显示速度 ≥ 该值的 IP；没测过速度的不算达标，也隐藏；值记在浏览器里 */
    const [speedMin, setSpeedMin] = useState<string>(() => {
        try { return localStorage.getItem('CF_SAVED_SPEED_MIN') || ''; } catch { return ''; }
    });
    // 已保存列表平时不常翻，支持收起；状态记在浏览器里，默认展开
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem('CF_SAVED_LIST_COLLAPSED') === '1'; } catch { return false; }
    });
    const { showToast } = useToast();
    const { confirm } = useConfirm();

    // ---------- 批量按需测试（勾选 + 右上角一键探针复检 / 一键测延迟 / 一键测下载速度） ----------
    interface RowTest {
        probe?: SingleProbeResult;
        speed?: SingleSpeedResult;
        latency?: SingleLatencyResult;
        testing?: 'probe' | 'speed' | 'latency';
    }
    const [rowTests, setRowTests] = useState<Record<string, RowTest>>({});
    /** 正在跑的批量测试：种类 + 进度（已完成 / 总数） */
    const [batchKind, setBatchKind] = useState<'probe' | 'speed' | 'latency' | null>(null);
    const [batchDone, setBatchDone] = useState(0);
    const [batchTotal, setBatchTotal] = useState(0);
    /** 测延迟当前是第几遍 / 共几遍（3 遍拉开时间测，抖动才准）；探针/测速不用 */
    const [batchPass, setBatchPass] = useState(0);
    const [batchRounds, setBatchRounds] = useState(0);
    /** 本批测延迟攒下的新延迟：整批跑完一次性写回已保存数据，避免 4 并发各写各的互相覆盖 */
    const latencyUpdates = useRef<Record<string, { latency: number; latencies?: number[]; lossPct?: number; jitterMs?: number }>>({});
    /** 本批测下载速度攒下的新速度：整批跑完一次性写回已保存数据（和测延迟同一套路，失败的行不更新） */
    const speedUpdates = useRef<Record<string, { speedMbps: number }>>({});
    // 本地后端地址：首次测试时用 probeLocalAgent 自行探测并记住，
    // 与 ScannerConfig / ScannerResults 共用同一后端（默认 13335）。
    const [agentBase, setAgentBase] = useState<string | null>(null);

    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    const itemKey = (item: FlatIpItem) => `${item.ip}:${item.port}#${item.sceneName}`;

    const getAgentBase = async (): Promise<string | null> => {
        if (agentBase) return agentBase;
        const port = Number(localStorage.getItem('LOCAL_AGENT_PORT') || '') || DEFAULT_AGENT_PORT;
        const r = await probeLocalAgent(port);
        if (!r.online) {
            showToast('本地后端未连接，请先启动本地后端', 'error');
            return null;
        }
        setAgentBase(r.baseUrl);
        return r.baseUrl;
    };

    /** 整轮扫描进行中时不测：先查 /status，收到后端 409 也一样处理 */
    const checkBusy = async (base: string): Promise<boolean> => {
        try {
            const res = await fetch(`${base}/status`);
            const s = await res.json() as { running?: boolean };
            if (s?.running) {
                showToast('请等扫描结束再测', 'warning');
                return true;
            }
        } catch {
            // 查不到就交给后端 409 判断
        }
        return false;
    };

    /** 旧版本地后端没有 /latency、/speed、/probe 接口：先用一个空请求探一下，
     *  404 就直接提示重编重启，别让整批几十个全报失败还看不出原因。
     *  接口存在时空请求只会回 400（缺 IP/端口），不算失败。 */
    const checkEndpoint = async (base: string, path: '/latency' | '/speed' | '/probe'): Promise<boolean> => {
        try {
            const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (res.status === 404) {
                showToast('本地后端太旧，没有这个接口：请先覆盖 main.go、跑 build.bat 重编、再重启 exe', 'error');
                return false;
            }
            return true;
        } catch {
            return true;
        }
    };

    const readProbeHost = (): string => {
        try { return (localStorage.getItem(PROBE_HOST_KEY) || '').trim(); } catch { return ''; }
    };

    /** 测延迟沿用扫描页的参数：轮次 / 超时 / 方式，改扫描参数即改这里 */
    const readLatencyParams = (): { rounds: number; timeoutMs: number; scanMode: 'tcping' | 'httping' } => {
        const fallback = { rounds: DEFAULT_SCAN_PARAMS.rounds, timeoutMs: DEFAULT_SCAN_PARAMS.timeoutMs, scanMode: DEFAULT_SCAN_PARAMS.scanMode };
        try {
            const raw = localStorage.getItem(SCAN_PARAMS_KEY);
            if (!raw) return fallback;
            const p = JSON.parse(raw);
            return {
                rounds: typeof p.rounds === 'number' && p.rounds >= 1 && p.rounds <= 5 ? p.rounds : fallback.rounds,
                timeoutMs: typeof p.timeoutMs === 'number' && p.timeoutMs > 0 ? p.timeoutMs : fallback.timeoutMs,
                scanMode: p.scanMode === 'httping' ? 'httping' : 'tcping',
            };
        } catch {
            return fallback;
        }
    };

    /**
     * 本批测延迟攒下的新延迟一次性写回：更新列表里的延迟/丢包/抖动并按新延迟重排，
     * 再把涉及的场景整场景覆盖保存。失败的行不更新，留着旧值。
     */
    const persistLatencyUpdates = async (): Promise<number> => {
        const updates = latencyUpdates.current;
        const keys = Object.keys(updates);
        if (keys.length === 0) return 0;
        latencyUpdates.current = {};
        const nextItems = items.map(it => {
            const u = updates[itemKey(it)];
            return u ? { ...it, latency: u.latency, latencies: u.latencies, lossPct: u.lossPct, jitterMs: u.jitterMs } : it;
        });
        setItems(nextItems);
        const scenes = new Set(nextItems.filter(it => updates[itemKey(it)]).map(it => it.sceneName));
        for (const scene of scenes) {
            const sceneItems = nextItems.filter(i => i.sceneName === scene).map(({ sceneName, ...rest }) => rest);
            await saveResults(scene, sceneItems as ScanResult[], 'overwrite');
        }
        return keys.length;
    };

    /**
     * 本批测下载速度攒下的新速度一次性写回：更新列表里的速度，
     * 再把涉及的场景整场景覆盖保存。失败的行不更新，留着旧值。
     */
    const persistSpeedUpdates = async (): Promise<number> => {
        const updates = speedUpdates.current;
        const keys = Object.keys(updates);
        if (keys.length === 0) return 0;
        speedUpdates.current = {};
        const nextItems = items.map(it => {
            const u = updates[itemKey(it)];
            return u ? { ...it, speedMbps: u.speedMbps } : it;
        });
        setItems(nextItems);
        const scenes = new Set(nextItems.filter(it => updates[itemKey(it)]).map(it => it.sceneName));
        for (const scene of scenes) {
            const sceneItems = nextItems.filter(i => i.sceneName === scene).map(({ sceneName, ...rest }) => rest);
            await saveResults(scene, sceneItems as ScanResult[], 'overwrite');
        }
        return keys.length;
    };

    /**
     * 测其中一行（不触发整轮扫描；探针/测速只显示结果不改数据。
     * 批量测延迟已改走 runLatencyBatch 的 3 遍流程，这里 latency 分支只作保留，
     * 成功后仍把新延迟攒起来供 persistLatencyUpdates 写回）。
     * 返回 false 表示后端正忙（409），调用方应停止整批；其它单条失败
     * 只记为不通 / 测速失败 / 测延迟失败，不中断整批。
     */
    const runSingleTest = async (item: FlatIpItem, kind: 'probe' | 'speed' | 'latency', base: string): Promise<boolean> => {
        const key = itemKey(item);
        setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: kind } }));
        const latencyParams = kind === 'latency' ? readLatencyParams() : null;
        const req = {
            host: item.ip,
            ip: item.resolvedIp || item.ip,
            port: item.port,
            probeHost: readProbeHost(),
            speedUrl: 'auto',
            timeoutMs: latencyParams ? latencyParams.timeoutMs : 5000,
            ...(latencyParams ? { scanMode: latencyParams.scanMode, rounds: latencyParams.rounds } : {}),
        };
        try {
            if (kind === 'probe') {
                const res = await probeSingle(base, req);
                setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: undefined, probe: res } }));
            } else if (kind === 'latency') {
                const res = await latencySingle(base, req);
                setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: undefined, latency: res } }));
                if (res.ok && res.latency !== undefined) {
                    latencyUpdates.current[key] = { latency: res.latency, latencies: res.latencies, lossPct: res.lossPct, jitterMs: res.jitterMs };
                }
            } else {
                let res = await speedSingle(base, req);
                // 429 是测速端限流：等 5 秒再试一次，还 429 就把原因留给表内显示
                if (!res.ok && res.error && /429/.test(res.error)) {
                    await sleep(5000);
                    res = await speedSingle(base, req);
                }
                setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: undefined, speed: res } }));
                if (res.ok && res.speedMbps !== undefined) {
                    speedUpdates.current[key] = { speedMbps: res.speedMbps };
                }
            }
            return true;
        } catch (e) {
            if (e instanceof Error && e.message === AGENT_BUSY_ERROR) {
                setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: undefined } }));
                return false;
            }
            setRowTests(prev => ({
                ...prev,
                [key]: {
                    ...prev[key],
                    testing: undefined,
                    ...(kind === 'probe'
                        ? { probe: { ok: false, error: e instanceof Error ? e.message : '未知错误' } }
                        : kind === 'latency'
                            ? { latency: { ok: false, error: e instanceof Error ? e.message : '未知错误' } }
                            : { speed: { ok: false, error: e instanceof Error ? e.message : '未知错误' } }),
                },
            }));
            return true;
        }
    };

    /**
     * 一键测延迟（3 遍拉开时间测）：每遍把所有已勾选 IP 各测 1 次（rounds=1），
     * 3 遍跑完再一起算、一起更新。连着测同一个 IP 3 次，抖动容易偏小（常测出 0），
     * 拉开时间的 3 遍算出的抖动（最大减最小）才有参考价值。
     * 延迟列从第一轮起就只更新延迟（取目前测到的最低值），让用户看到在动；
     * 丢包和抖动要等 3 遍全测完才能算，结束时和延迟一起刷新、一起写回。
     * 丢包/抖动即使是 0 也明确写 0，不再用 undefined 盖掉旧值。
     */
    const runLatencyBatch = async (targets: FlatIpItem[], base: string) => {
        const { rounds, timeoutMs, scanMode } = readLatencyParams();
        const acc: Record<string, { latencies: number[]; failures: number; lastError?: string }> = {};
        for (const item of targets) acc[itemKey(item)] = { latencies: [], failures: 0 };
        latencyUpdates.current = {};
        speedUpdates.current = {};
        setBatchKind('latency');
        setBatchDone(0);
        setBatchTotal(targets.length * rounds);
        setBatchPass(0);
        setBatchRounds(rounds);
        const busy = { value: false };
        // 单遍里测其中一个 IP 一次（rounds=1），成功就把延迟列刷新为目前最低值
        const runOneRound = async (item: FlatIpItem): Promise<boolean> => {
            const key = itemKey(item);
            setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: 'latency' } }));
            try {
                const res = await latencySingle(base, {
                    host: item.ip,
                    ip: item.resolvedIp || item.ip,
                    port: item.port,
                    probeHost: readProbeHost(),
                    speedUrl: 'auto',
                    timeoutMs,
                    scanMode,
                    rounds: 1,
                });
                if (res.ok && res.latency !== undefined) {
                    acc[key].latencies.push(res.latency);
                    const bestSoFar = Math.min(...acc[key].latencies);
                    setItems(prev => prev.map(it => itemKey(it) === key ? { ...it, latency: bestSoFar } : it));
                } else {
                    acc[key].failures++;
                    acc[key].lastError = res.error || '测延迟失败';
                }
            } catch (e) {
                if (e instanceof Error && e.message === AGENT_BUSY_ERROR) {
                    setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: undefined } }));
                    return false;
                }
                acc[key].failures++;
                acc[key].lastError = e instanceof Error ? e.message : '未知错误';
            }
            setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: undefined } }));
            return true;
        };
        try {
            for (let pass = 0; pass < rounds && !busy.value; pass++) {
                setBatchPass(pass + 1);
                let idx = 0;
                const worker = async () => {
                    while (idx < targets.length && !busy.value) {
                        const item = targets[idx++];
                        const ok = await runOneRound(item);
                        if (!ok) {
                            busy.value = true;
                            break;
                        }
                        setBatchDone(d => d + 1);
                    }
                };
                await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
            }
        } finally {
            setBatchKind(null);
            setBatchPass(0);
            setBatchRounds(0);
        }
        if (busy.value) {
            showToast('请等扫描结束再测', 'warning');
            return;
        }
        for (const item of targets) {
            const key = itemKey(item);
            const a = acc[key];
            if (a.latencies.length > 0) {
                const best = Math.min(...a.latencies);
                const worst = Math.max(...a.latencies);
                latencyUpdates.current[key] = {
                    latency: best,
                    latencies: [...a.latencies],
                    lossPct: (a.failures / rounds) * 100,
                    jitterMs: a.latencies.length >= 2 ? worst - best : 0,
                };
            } else {
                setRowTests(prev => ({
                    ...prev,
                    [key]: { ...prev[key], testing: undefined, latency: { ok: false, error: a.lastError || '测延迟失败：全部轮次不通' } },
                }));
            }
        }
        const updated = await persistLatencyUpdates();
        showToast(updated > 0 ? `测延迟完成：共 ${targets.length} 个，已更新 ${updated} 条延迟` : `测延迟完成：共 ${targets.length} 个，没有可更新的延迟`, updated > 0 ? 'success' : 'warning');
    };

    /** 一键批量测试（探针/测速）：只测已勾选且当前可见的行；探针最多 4 个并发，测速 2 个并发；测延迟走 runLatencyBatch */
    const runBatch = async (kind: 'probe' | 'speed' | 'latency', targets: FlatIpItem[]) => {
        if (batchKind) return;
        if (targets.length === 0) {
            showToast('请先勾选要测试的 IP', 'warning');
            return;
        }
        const base = await getAgentBase();
        if (!base) return;
        if (await checkBusy(base)) return;
        if (!(await checkEndpoint(base, kind === 'probe' ? '/probe' : kind === 'latency' ? '/latency' : '/speed'))) return;
        // 测延迟走 3 遍拉开时间的专用流程（runLatencyBatch），探针/测速走下面通用流程
        if (kind === 'latency') {
            await runLatencyBatch(targets, base);
            return;
        }
        latencyUpdates.current = {};
        speedUpdates.current = {};
        setBatchKind(kind);
        setBatchDone(0);
        setBatchTotal(targets.length);
        const busy = { value: false };
        let idx = 0;
        // 测速降到 2 并发、每次开测间隔 500ms：一次几十个下载同时打过去，测速端会回 429 限流
        const concurrency = kind === 'speed' ? 2 : 4;
        const worker = async () => {
            while (idx < targets.length && !busy.value) {
                const item = targets[idx++];
                if (kind === 'speed') await sleep(500);
                const ok = await runSingleTest(item, kind, base);
                if (!ok) {
                    busy.value = true;
                    break;
                }
                setBatchDone(d => d + 1);
            }
        };
        try {
            await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
        } finally {
            setBatchKind(null);
        }
        if (busy.value) {
            showToast('请等扫描结束再测', 'warning');
            return;
        }
        if (kind === 'probe') {
            showToast(`探针复检完成：共 ${targets.length} 个`, 'success');
        } else {
            const updated = await persistSpeedUpdates();
            showToast(updated > 0 ? `测速完成：共 ${targets.length} 个，已更新 ${updated} 条速度` : `测速完成：共 ${targets.length} 个，没有可更新的速度`, updated > 0 ? 'success' : 'warning');
        }
    };

    const loadData = async () => {
        setLoading(true);
        setItems([]); // Clear items before loading to avoid confusion
        setRowTests({});
        setBatchKind(null);
        setBatchDone(0);
        setBatchTotal(0);
        setBatchPass(0);
        setBatchRounds(0);
        try {
            // 1. 获取所有场景名
            const scenes = await getScenes();
            
            // 2. 并行获取所有场景的详细数据
            const promises = scenes.map(async (scene) => {
                try {
                    const results = await getSceneResults(scene.name);
                    return results.map(r => ({ ...r, sceneName: scene.name }));
                } catch (e) {
                    console.error(`Failed to load scene ${scene.name}`, e);
                    return [];
                }
            });

            const resultsArray = await Promise.all(promises);
            // 3. 扁平化数组
            const allItems = resultsArray.flat();
            setItems(allItems);
            setSelectedScenes(new Set(allItems.map(i => i.sceneName)));
        } catch (e) {
            console.error('Failed to load saved IPs', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, []);

    const uniqueScenes = Array.from(new Set(items.map(i => i.sceneName))).sort();
    /** 地区下拉的选项：只列出已保存数据里实际有的机房，按个数从多到少排 */
    const regionOptions = useMemo(() => {
        const counts = new Map<string, number>();
        for (const item of items) {
            if (!item.colo) continue;
            counts.set(item.colo, (counts.get(item.colo) ?? 0) + 1);
        }
        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([colo, count]) => ({ colo, count }));
    }, [items]);
    // 选中的地区已被删空时自动回到全部
    const effectiveRegion = regionOptions.some(r => r.colo === selectedRegion) ? selectedRegion : 'all';
    const latencyMaxNum = /^\d+$/.test(latencyMax.trim()) ? parseInt(latencyMax.trim(), 10) : null;
    const speedMinNum = /^\d+(\.\d+)?$/.test(speedMin.trim()) ? parseFloat(speedMin.trim()) : null;
    const filteredBySceneRegion = items.filter(i =>
        selectedScenes.has(i.sceneName) &&
        (effectiveRegion === 'all' || i.colo === effectiveRegion)
    );
    /** 延迟上限：只留延迟 ≤ 上限的；延迟 -1（无数据）的不算达标，也隐藏 */
    const filteredByLatency = latencyMaxNum === null
        ? filteredBySceneRegion
        : filteredBySceneRegion.filter(i => i.latency >= 0 && i.latency <= latencyMaxNum);
    const latencyHiddenCount = filteredBySceneRegion.length - filteredByLatency.length;
    /** 下载速度下限：没测过速度的按 0 算，速度 ≥ 下限才留；下限 > 0 时没测过的自然被隐藏 */
    const filteredItems = speedMinNum === null
        ? filteredByLatency
        : filteredByLatency.filter(i => (i.speedMbps ?? 0) >= speedMinNum);
    const speedHiddenCount = filteredByLatency.length - filteredItems.length;
    /** 丢包显示取一位小数：33.33333333333333% → 33.3%，整数保持原样 */
    const lossText = (v?: number) => v === undefined ? '' : (Number.isInteger(v) ? String(v) : v.toFixed(1));
    /** 表头排序：没数据的（丢包/抖动留空）永远排最后，不参与方向翻转；下载速度没测过的按 0 算，当最慢的 */
    const cmpOptNum = (a?: number, b?: number) => {
        if (a === undefined && b === undefined) return 0;
        if (a === undefined) return 1;
        if (b === undefined) return -1;
        return a - b;
    };
    const filteredItemsSorted = [...filteredItems].sort((a, b) => {
        const dir = sortDir === 'asc' ? 1 : -1;
        switch (sortKey) {
            case 'ip': return dir * a.ip.localeCompare(b.ip);
            case 'port': return dir * (a.port - b.port);
            case 'latency': return dir * (a.latency - b.latency);
            case 'lossPct': return dir * cmpOptNum(a.lossPct, b.lossPct);
            case 'jitterMs': return dir * cmpOptNum(a.jitterMs, b.jitterMs);
            case 'speedMbps': return dir * ((a.speedMbps ?? 0) - (b.speedMbps ?? 0));
            case 'colo': return dir * (a.colo || '').localeCompare(b.colo || '');
            case 'scene': return dir * a.sceneName.localeCompare(b.sceneName);
            default: return 0;
        }
    });

    /** 批量测试的入口：从当前可见行里取已勾选的 */
    const handleBatchClick = (kind: 'probe' | 'speed' | 'latency') => {
        const targets = filteredItemsSorted.filter(item => selectedItems.has(itemKey(item)));
        if (targets.length === 0) {
            showToast('请先勾选要测试的 IP', 'warning');
            return;
        }
        void runBatch(kind, targets);
    };

    const handleCheckboxChange = (id: string, checked: boolean) => {
        const newSet = new Set(selectedItems);
        if (checked) newSet.add(id);
        else newSet.delete(id);
        setSelectedItems(newSet);
    };

    /** 行全选/反选：对当前可见行勾选取反——全勾了就全取消，没全勾就全勾上（以前是切场景显隐，不对） */
    const handleToggleAllItems = () => {
        const visibleIds = filteredItems.map((item) => itemKey(item));
        const allChecked = visibleIds.length > 0 && visibleIds.every((id) => selectedItems.has(id));
        setSelectedItems((prev) => {
            const next = new Set(prev);
            if (allChecked) {
                for (const id of visibleIds) next.delete(id);
            } else {
                for (const id of visibleIds) next.add(id);
            }
            return next;
        });
    };

    const handleSelectAll = (checked: boolean) => {
        const newSet = new Set(selectedItems);
        filteredItems.forEach(item => {
            const id = `${item.ip}:${item.port}#${item.sceneName}`;
            if (checked) newSet.add(id);
            else newSet.delete(id);
        });
        setSelectedItems(newSet);
    };

    const handleDeleteSelected = async () => {
        if (selectedItems.size === 0) return;
        const isConfirmed = await confirm(`确定要删除选中的 ${selectedItems.size} 个IP/域名吗？`, {
            confirmText: '确定删除',
        });
        if (!isConfirmed) return;

        setLoading(true);
        try {
            const scenesToUpdate = new Set<string>();
            items.forEach(item => {
                if (selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`)) {
                    scenesToUpdate.add(item.sceneName);
                }
            });

            for (const scene of scenesToUpdate) {
                const sceneItems = items.filter(i => i.sceneName === scene);
                const keepItems = sceneItems.filter(item => !selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`));

                if (keepItems.length === 0) {
                    // 删空了：直接删掉整个场景，不留空壳
                    await deleteScene(scene);
                } else {
                    const resultsToSave = keepItems.map(({ sceneName, ...rest }) => rest);
                    await saveResults(scene, resultsToSave as ScanResult[], 'overwrite');
                }
            }
            setSelectedItems(new Set());
            await loadData();
            try { window.dispatchEvent(new CustomEvent('cf:scenes-changed')); } catch { /* 忽略 */ }
        } catch (e) {
            showToast('删除失败', 'error');
            setLoading(false);
        }
    };

    const handleDeleteScene = async (scene: string) => {
        const count = items.filter(i => i.sceneName === scene).length;
        const isConfirmed = await confirm(`确定要删除场景「${scene}」吗？其中的 ${count} 个IP/域名会一起删除，删除后无法恢复。`, {
            confirmText: '确定删除',
        });
        if (!isConfirmed) return;

        setLoading(true);
        try {
            await deleteScene(scene);
            setSelectedItems(new Set([...selectedItems].filter(id => !id.endsWith(`#${scene}`))));
            setSelectedScenes(prev => {
                const next = new Set(prev);
                next.delete(scene);
                return next;
            });
            showToast(`场景「${scene}」已删除`, 'success');
            await loadData();
            // 通知裂变订阅刷新场景下拉，不用手动刷新页面
            try { window.dispatchEvent(new CustomEvent('cf:scenes-changed')); } catch { /* 忽略 */ }
        } catch (e) {
            showToast('删除场景失败', 'error');
            setLoading(false);
        }
    };

    const handleExportCsv = () => {
        if (filteredItemsSorted.length === 0) {
            showToast('没有可导出的数据', 'warning');
            return;
        }

        const headers = ['IP地址', '端口', '3次延迟(ms)', '最好延迟(ms)', '丢包(%)', '抖动(ms)', '下载速度(MB/s)', '来源', '地区代码', '地区名称', '场景'];
        const csvContent = [
            headers.join(','),
            ...filteredItemsSorted.map(item => [
                item.ip,
                item.port,
                item.latencies && item.latencies.length > 0 ? item.latencies.join('/') : '',
                item.latency,
                item.lossPct !== undefined ? lossText(item.lossPct) : '',
                item.jitterMs !== undefined ? item.jitterMs : '',
                (item.speedMbps ?? 0).toFixed(1),
                item.source ? SOURCE_LABELS[item.source] : '',
                item.colo || '',
                getColoName(item.colo || ''),
                item.sceneName,
            ].map(field => {
                const stringField = String(field);
                // Escape quotes and wrap in quotes if contains comma, quote or newline
                if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
                    return `"${stringField.replace(/"/g, '""')}"`;
                }
                return stringField;
            }).join(','))
        ].join('\n');

        // Add BOM for Excel compatibility
        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `ip_list_export_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleExportTxt = async () => {
        if (filteredItemsSorted.length === 0) {
            showToast('没有可导出的数据', 'warning');
            return;
        }

        try {
            let txtContent = '';
            for (const item of filteredItemsSorted) {
                const regionName = getColoName(item.colo || '');
                const sceneName = item.sceneName;
                const latency = `${item.latency}ms`;
                const extra = [
                    item.source ? SOURCE_LABELS[item.source] : '',
                    item.lossPct !== undefined ? `丢包${lossText(item.lossPct)}%` : '',
                    item.jitterMs !== undefined ? `抖动${item.jitterMs}ms` : '',
                    `速度${(item.speedMbps ?? 0).toFixed(1)}MB/s`,
                ].filter(Boolean).join('|');
                const comment = [regionName, sceneName, latency, extra].filter(Boolean).join('|');
                txtContent += `${item.ip}:${item.port}#${comment}\n`;
            }

            // Create a new file with the TXT data.
            const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8;' });
            const link = document.createElement('a');
            const url = URL.createObjectURL(blob);
            link.setAttribute('href', url);
            link.setAttribute('download', `ip_list_export_${new Date().toISOString().slice(0, 10)}.txt`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

        } catch (error) {
            console.error('Failed to export to TXT:', error);
            showToast(`导出TXT失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error');
        }
    };

    const handleCopyToClipboard = () => {
        if (filteredItemsSorted.length === 0) {
            showToast('没有可复制的数据', 'warning');
            return;
        }

        let txtContent = '';
        for (const item of filteredItemsSorted) {
            const regionName = getColoName(item.colo || '').replace(/^(\p{Regional_Indicator}+)\s+/u, '$1');
            const sceneName = item.sceneName;
            const latency = `${item.latency}ms`;
            const extra = [
                item.source ? SOURCE_LABELS[item.source] : '',
                item.lossPct !== undefined ? `丢包${lossText(item.lossPct)}%` : '',
                item.jitterMs !== undefined ? `抖动${item.jitterMs}ms` : '',
                `速度${(item.speedMbps ?? 0).toFixed(1)}MB/s`,
            ].filter(Boolean).join('|');
            const comment = [regionName, sceneName, latency, extra].filter(Boolean).join('|');
            txtContent += `${item.ip}:${item.port}#${comment}\n`;
        }

        navigator.clipboard.writeText(txtContent).then(() => {
            showToast('已复制到剪贴板', 'success');
        }).catch(err => {
            console.error('Failed to copy to clipboard:', err);
            showToast('复制失败，请检查浏览器权限', 'error');
        });
    };


    const isAllSelected = filteredItems.length > 0 && filteredItems.every(item => selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`));

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center justify-between flex-wrap gap-4 mb-4">
                    <div className="flex items-center gap-3">
                        <ListChecks className="w-7 h-7 text-green-500" />
                        <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">已保存 IP 库</h2>
                        <span className="px-2.5 py-0.5 bg-green-100 text-green-800 text-sm font-semibold rounded-full dark:bg-green-900 dark:text-green-300">{items.length} 个IP/域名</span>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            const next = !collapsed;
                            setCollapsed(next);
                            try { localStorage.setItem('CF_SAVED_LIST_COLLAPSED', next ? '1' : '0'); } catch { /* 忽略 */ }
                        }}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 transition-colors"
                        title={collapsed ? '展开已保存列表' : '收起已保存列表'}
                    >
                        {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                        <span>{collapsed ? '展开' : '收起'}</span>
                    </button>
                </div>

            {collapsed ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    {items.length > 0 ? `共 ${items.length} 个 IP/域名 · ${uniqueScenes.length} 个场景` : '暂无已保存的 IP'}
                </p>
            ) : (
                <>
                <div className="flex flex-wrap items-center gap-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg mb-4">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">场景过滤:</span>
                    <div className="flex flex-wrap items-center gap-2">
                        {uniqueScenes.map(scene => {
                            const isSelected = selectedScenes.has(scene);
                            return (
                                <span
                                    key={scene}
                                    className={`inline-flex items-center rounded-full border transition-colors ${
                                        isSelected
                                            ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                            : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                    }`}
                                >
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const newSet = new Set(selectedScenes);
                                            if (newSet.has(scene)) newSet.delete(scene);
                                            else newSet.add(scene);
                                            setSelectedScenes(newSet);
                                        }}
                                        className="px-2.5 py-1 text-xs font-medium"
                                    >
                                        {scene}
                                    </button>
                                    <button
                                        type="button"
                                        title={`删除场景 ${scene}`}
                                        aria-label={`删除场景 ${scene}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void handleDeleteScene(scene);
                                        }}
                                        className="pr-2 pl-0.5 py-1 text-xs font-bold leading-none opacity-60 hover:opacity-100 hover:text-red-600"
                                    >
                                        ×
                                    </button>
                                </span>
                                );
                            })}
                        </div>
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap ml-2">地区:</span>
                        <select
                            value={effectiveRegion}
                            onChange={(e) => setSelectedRegion(e.target.value)}
                            className="px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-full hover:border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600 outline-none cursor-pointer"
                            title="按地区筛选"
                        >
                            <option value="all">全部地区</option>
                            {regionOptions.map(({ colo, count }) => (
                                <option key={colo} value={colo}>{colo} · {getColoName(colo)}（{count} 个）</option>
                            ))}
                        </select>
                        <span className="flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap ml-2" title="只显示延迟不超过该值的 IP，高于该值的不显示；留空为全部显示">
                            延迟 ≤
                            <input
                                type="text"
                                inputMode="numeric"
                                value={latencyMax}
                                placeholder="不限"
                                onChange={(e) => {
                                    const v = e.target.value.replace(/[^\d]/g, '').slice(0, 5);
                                    setLatencyMax(v);
                                    try { localStorage.setItem('CF_SAVED_LATENCY_MAX', v); } catch { /* 忽略 */ }
                                }}
                                className="w-16 px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-full text-center dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600 outline-none focus:border-indigo-400"
                            />
                            ms
                            {latencyMaxNum !== null && latencyHiddenCount > 0 && (
                                <span className="text-gray-400 dark:text-gray-500 font-normal">已隐藏 {latencyHiddenCount} 个</span>
                            )}
                        </span>
                        <span className="flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap ml-2" title="只显示下载速度不低于该值的 IP，没测过速度的按 0 算；留空为全部显示">
                            速度 ≥
                            <input
                                type="text"
                                inputMode="decimal"
                                value={speedMin}
                                placeholder="不限"
                                onChange={(e) => {
                                    const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1').slice(0, 6);
                                    setSpeedMin(v);
                                    try { localStorage.setItem('CF_SAVED_SPEED_MIN', v); } catch { /* 忽略 */ }
                                }}
                                className="w-16 px-2 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-full text-center dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600 outline-none focus:border-indigo-400"
                            />
                            MB/s
                            {speedMinNum !== null && speedHiddenCount > 0 && (
                                <span className="text-gray-400 dark:text-gray-500 font-normal">已隐藏 {speedHiddenCount} 个</span>
                            )}
                        </span>
                        {/* 场景过滤行只留场景清空和场景管理；行勾选/删除移到下面第二行 */}
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setSelectedScenes(new Set())}
                                title="取消全部场景的显示"
                                className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                            >
                                清空
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowSceneManage(v => !v)}
                                title="列出全部场景，可删除自定义命名的场景"
                                className="px-3 py-1 text-xs font-medium text-indigo-800 bg-indigo-100 rounded-full hover:bg-indigo-200 dark:bg-indigo-900 dark:text-indigo-300 dark:hover:bg-indigo-800 transition-colors"
                            >
                                场景管理
                            </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 w-full justify-between border-t border-gray-200 dark:border-gray-600 pt-3 mt-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    onClick={handleToggleAllItems}
                                    title="对当前可见行勾选取反：全勾了就全取消，没全勾就全勾上"
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                                >
                                    全选/反选
                                </button>
                                {selectedItems.size > 0 && (
                                    <button
                                        onClick={handleDeleteSelected}
                                        className="px-3 py-1 text-xs font-medium text-red-800 bg-red-100 rounded-full hover:bg-red-200 dark:bg-red-900 dark:text-red-300 dark:hover:bg-red-800 transition-colors"
                                    >
                                        <Trash2 className="w-3.5 h-3.5 mr-1 inline-block" />
                                        删除选中 ({selectedItems.size})
                                    </button>
                                )}
                                <span className="text-xs text-gray-500 dark:text-gray-400">已勾选 {selectedItems.size} 个</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                            {/* 批量测试：只测已勾选的行，探针/测延迟最多 4 个并发，测速 2 个并发 */}
                            <button
                                type="button"
                                onClick={() => handleBatchClick('probe')}
                                disabled={batchKind !== null}
                                className="px-3 py-1 text-xs font-medium text-teal-800 bg-teal-100 rounded-full hover:bg-teal-200 dark:bg-teal-900 dark:text-teal-300 dark:hover:bg-teal-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {batchKind === 'probe' ? `探针复检中 ${batchDone}/${batchTotal}…` : '一键探针复检'}
                            </button>
                            <button
                                type="button"
                                onClick={() => handleBatchClick('latency')}
                                disabled={batchKind !== null}
                                className="px-3 py-1 text-xs font-medium text-emerald-800 bg-emerald-100 rounded-full hover:bg-emerald-200 dark:bg-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {batchKind === 'latency' ? `测延迟中${batchRounds > 0 ? ` 第 ${batchPass}/${batchRounds} 轮` : ''} ${batchDone}/${batchTotal}…` : '一键测延迟'}
                            </button>
                            <button
                                type="button"
                                onClick={() => handleBatchClick('speed')}
                                disabled={batchKind !== null}
                                className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {batchKind === 'speed' ? `下载测速中 ${batchDone}/${batchTotal}…` : '一键测下载速度'}
                            </button>
                            <button
                                onClick={loadData}
                                className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                            >
                                <RotateCw className="w-3.5 h-3.5 mr-1 inline-block" />
                                刷新
                            </button>
                            </div>
                        </div>
                </div>

            {/* 场景管理：列出全部场景和个数，可删除自定义命名的场景 */}
            {showSceneManage && (
                <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">场景管理（共 {uniqueScenes.length} 个场景）</span>
                        <button
                            type="button"
                            onClick={() => setShowSceneManage(false)}
                            className="px-2 py-0.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                        >
                            收起
                        </button>
                    </div>
                    {uniqueScenes.length === 0 ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">暂无已保存场景</p>
                    ) : (
                        <div className="flex flex-wrap gap-2">
                            {uniqueScenes.map((s) => {
                                const count = items.filter((i) => i.sceneName === s).length;
                                return (
                                    <span key={s} className="inline-flex items-center gap-2 px-2.5 py-1 text-xs font-medium rounded-full bg-white text-gray-700 border border-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600">
                                        {s}（{count} 个）
                                        <button
                                            type="button"
                                            title={`删除场景 ${s}`}
                                            onClick={() => void handleDeleteScene(s)}
                                            className="px-2 py-0.5 text-xs font-medium text-red-800 bg-red-100 rounded-full hover:bg-red-200 dark:bg-red-900 dark:text-red-300 dark:hover:bg-red-800 transition-colors"
                                        >
                                            删除
                                        </button>
                                    </span>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* 批量测试进度条：跑的时候才显示，跑完就消失；测延迟是 3 遍全量，第几遍也写出来 */}
            {batchKind !== null && batchTotal > 0 && (
                <div className="mb-4">
                    <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                        <span>
                            {batchKind === 'probe' ? '探针复检中' : batchKind === 'latency' ? `测延迟中${batchRounds > 0 ? ` · 第 ${batchPass} / ${batchRounds} 轮` : ''}` : '下载测速中'}
                        </span>
                        <span>{batchDone} / {batchTotal}（{Math.round((batchDone / batchTotal) * 100)}%）</span>
                    </div>
                    <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                            className={`h-full rounded-full transition-all ${batchKind === 'probe' ? 'bg-teal-500' : batchKind === 'latency' ? 'bg-emerald-500' : 'bg-blue-500'}`}
                            style={{ width: `${Math.min(100, Math.round((batchDone / batchTotal) * 100))}%` }}
                        />
                    </div>
                </div>
            )}

            <div className="overflow-auto" style={{ maxHeight: '600px' }}>
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0 z-10">
                        <tr>
                            <th className="px-4 py-3 text-left">
                                <input 
                                    type="checkbox" 
                                    checked={isAllSelected}
                                    onChange={(e) => handleSelectAll(e.target.checked)}
                                    className="rounded text-purple-600 focus:ring-purple-500 h-4 w-4"
                                />
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <button type="button" onClick={() => toggleSort('ip')} className="hover:text-gray-800 dark:hover:text-white" title="按 IP/域名排序">IP/域名{sortArrow('ip')}</button>
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">来源</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <button type="button" onClick={() => toggleSort('port')} className="hover:text-gray-800 dark:hover:text-white" title="按端口排序">端口{sortArrow('port')}</button>
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <button type="button" onClick={() => toggleSort('latency')} className="hover:text-gray-800 dark:hover:text-white" title="按延迟排序">延迟{sortArrow('latency')}</button>
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <button type="button" onClick={() => toggleSort('lossPct')} className="hover:text-gray-800 dark:hover:text-white" title="按丢包排序">丢包{sortArrow('lossPct')}</button>
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <button type="button" onClick={() => toggleSort('jitterMs')} className="hover:text-gray-800 dark:hover:text-white" title="按抖动排序">抖动{sortArrow('jitterMs')}</button>
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <button type="button" onClick={() => toggleSort('speedMbps')} className="hover:text-gray-800 dark:hover:text-white" title="按下载速度排序">下载速度{sortArrow('speedMbps')}</button>
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <button type="button" onClick={() => toggleSort('colo')} className="hover:text-gray-800 dark:hover:text-white" title="按地区代码排序">地区代码{sortArrow('colo')}</button>
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <select
                                    value={effectiveRegion}
                                    onChange={(e) => setSelectedRegion(e.target.value)}
                                    className="px-2 py-1 text-xs font-medium normal-case text-gray-700 bg-white border border-gray-200 rounded-full hover:border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600 outline-none cursor-pointer"
                                    title="按地区筛选（和上面筛选栏联动）"
                                >
                                    <option value="all">地区：全部</option>
                                    {regionOptions.map(({ colo, count }) => (
                                        <option key={colo} value={colo}>{colo} · {getColoName(colo)}（{count} 个）</option>
                                    ))}
                                </select>
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                <button type="button" onClick={() => toggleSort('scene')} className="hover:text-gray-800 dark:hover:text-white" title="按场景排序">场景{sortArrow('scene')}</button>
                            </th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">复检结果</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                        {loading ? (
                            <tr><td colSpan={12} className="px-4 py-4 text-center text-gray-500">加载中...</td></tr>
                        ) : filteredItems.length === 0 ? (
                            <tr><td colSpan={12} className="px-4 py-4 text-center text-gray-500">暂无数据</td></tr>
                        ) : (
                            filteredItemsSorted.map((item) => (
                                <tr key={`${item.ip}-${item.port}-${item.sceneName}`} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                    <td className="px-4 py-2">
                                        <input 
                                            type="checkbox"
                                            checked={selectedItems.has(`${item.ip}:${item.port}#${item.sceneName}`)}
                                            onChange={(e) => handleCheckboxChange(`${item.ip}:${item.port}#${item.sceneName}`, e.target.checked)}
                                            className="rounded text-purple-600 focus:ring-purple-500 h-4 w-4"
                                        />
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-white">
                                        {item.ip}
                                        {item.domain && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">域名</span>}
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.source ? SOURCE_LABELS[item.source] : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.port}</td>
                                    <td className={`px-4 py-2 whitespace-nowrap text-sm font-semibold ${getLatencyColor(item.latency)}`}>
                                        {item.latency > -1 ? `${item.latency}ms` : 'N/A'}
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.lossPct !== undefined ? `${lossText(item.lossPct)}%` : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.jitterMs !== undefined ? `${item.jitterMs}ms` : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                        {(() => {
                                            const t = rowTests[itemKey(item)];
                                            if (t?.testing === 'speed') return <span className="text-blue-600">测速中…</span>;
                                            return <span className="font-semibold text-blue-600">{(item.speedMbps ?? 0).toFixed(1)} MB/s</span>;
                                        })()}
                                    </td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.colo || '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.colo ? <RegionDisplay colo={item.colo} flagSize="sm" /> : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.sceneName}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                        {(() => {
                                            const t = rowTests[itemKey(item)];
                                            return (
                                                <div className="flex flex-col gap-1">
                                                    {t?.testing === 'probe' && <span className="text-teal-600">探针中…</span>}
                                                    {t?.testing === 'latency' && <span className="text-emerald-600">测延迟中…</span>}
                                                    {t?.probe && (
                                                        <span className={t.probe.ok ? 'text-green-600' : 'text-red-600'}>
                                                            {t.probe.ok
                                                                ? `通${t.probe.colo ? ` ${t.probe.colo}` : ''}${t.probe.latencyMs !== undefined ? ` ${t.probe.latencyMs}ms` : ''}`
                                                                : `不通${t.probe.error ? `（${t.probe.error}）` : ''}`}
                                                        </span>
                                                    )}
                                                    {/* 延迟/速度的成功结果各回自己的列，这里只留失败原因 */}
                                                    {t?.latency && !t.latency.ok && (
                                                        <span className="text-red-600 whitespace-normal break-all" title={t.latency.error || ''}>
                                                            {`测延迟失败${t.latency.error ? `（${t.latency.error}）` : ''}`}
                                                        </span>
                                                    )}
                                                    {t?.speed && !t.speed.ok && (
                                                        <span className="text-red-600 whitespace-normal break-all" title={t.speed.error || ''}>
                                                            {`测速失败${t.speed.error ? `（${t.speed.error}）` : ''}`}
                                                        </span>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>

            </div>
            <div className="mt-8 flex justify-center gap-4">
                    <button onClick={handleExportCsv} className="flex items-center px-4 py-2 font-bold text-white bg-green-600 rounded hover:bg-green-700 transition-colors">
                        <File className="w-4 h-4 mr-2" />
                        导出 CSV
                    </button>
                    <button onClick={handleExportTxt} className="flex items-center px-4 py-2 font-bold text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors">
                         <FileText className="w-4 h-4 mr-2" />
                        导出 TXT
                    </button>
                    <button onClick={handleCopyToClipboard} className="flex items-center px-4 py-2 font-bold text-white bg-purple-600 rounded hover:bg-purple-700 transition-colors">
                        <Copy className="w-4 h-4 mr-2" />
                        复制
                    </button>
            </div>
                </>
            )}
        </div>
    );
}