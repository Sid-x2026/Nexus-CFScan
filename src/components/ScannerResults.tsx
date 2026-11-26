import { useState, useEffect, useRef } from 'react';
import { saveResults, getScenes } from '../api';
import { ScanResult, getLatencyColor, SOURCE_LABELS, type SourceKind } from '../utils/scanner';
import {
    probeLocalAgent, probeSingle, speedSingle, DEFAULT_AGENT_PORT, AGENT_BUSY_ERROR,
    type SingleProbeResult, type SingleSpeedResult,
} from '../utils/localAgent';
import { useToast } from './Toast';
import { ListFilter, Save } from 'lucide-react';
import { RegionDisplay } from './RegionDisplay';

/** 与 ScannerConfig 的探针域名输入框共用同一个 localStorage 键 */
const PROBE_HOST_KEY = 'CF_PROBE_HOST';

interface IpScannerResultsAndSaveProps {
    scanResults: ScanResult[];
    onSaveSuccess?: () => void;
}

const DEFAULT_IPS_PER_REGION = 20;

export function ScannerResults({ scanResults, onSaveSuccess }: IpScannerResultsAndSaveProps) {
    const [ipsPerRegion, setIpsPerRegion] = useState<string>(String(DEFAULT_IPS_PER_REGION));
    const [ipsPerRegionError, setIpsPerRegionError] = useState<string>('');
    const [isLatencyFilterEnabled, setIsLatencyFilterEnabled] = useState(false);
    const [isRegionLimitEnabled, setIsRegionLimitEnabled] = useState(false);
    const [latencyFilterValue, setLatencyFilterValue] = useState<string>('180');
    const [latencyFilterError, setLatencyFilterError] = useState<string>('');
    const [isSaving, setIsSaving] = useState(false);
    const [sceneName, setSceneName] = useState('');
    const [scenes, setScenes] = useState<string[]>([]);
    const [sceneDropdownOpen, setSceneDropdownOpen] = useState(false);
    const sceneInputRef = useRef<HTMLDivElement>(null);
    const [saveMode, setSaveMode] = useState<'overwrite' | 'append'>('overwrite');
    const [selectedRegions, setSelectedRegions] = useState<Set<string>>(new Set());
    const [selectedPorts, setSelectedPorts] = useState<Set<string>>(new Set());
    const [selectedSources, setSelectedSources] = useState<Set<SourceKind>>(new Set());
    const filterInitialized = useRef(false);

    // ---------- 批量按需测试（勾选 + 右上角一键探针复检 / 一键测下载速度） ----------
    interface RowTest {
        probe?: SingleProbeResult;
        speed?: SingleSpeedResult;
        testing?: 'probe' | 'speed';
    }
    const [rowTests, setRowTests] = useState<Record<string, RowTest>>({});
    /** 已勾选的行，键为 `${ip}:${port}` */
    const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
    /** 正在跑的批量测试：种类 + 进度（已完成 / 总数） */
    const [batchKind, setBatchKind] = useState<'probe' | 'speed' | null>(null);
    const [batchDone, setBatchDone] = useState(0);
    const [batchTotal, setBatchTotal] = useState(0);
    // 本地后端地址：首次测试时用 probeLocalAgent 自行探测并记住，
    // 与 ScannerConfig 共用同一后端（默认 13335，LOCAL_AGENT_PORT 可改）。
    const [agentBase, setAgentBase] = useState<string | null>(null);
    const { showToast } = useToast();

    // 新一轮扫描结果来了（或结果被清空）：复检结果和勾选一并清掉
    useEffect(() => {
        setRowTests({});
        setCheckedKeys(new Set());
        setBatchKind(null);
        setBatchDone(0);
        setBatchTotal(0);
    }, [scanResults]);

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

    const readProbeHost = (): string => {
        try { return (localStorage.getItem(PROBE_HOST_KEY) || '').trim(); } catch { return ''; }
    };

    const rowKey = (row: Pick<ScanResult, 'ip' | 'port'>) => `${row.ip}:${row.port}`;

    /**
     * 测其中一行（不触发整轮扫描）。返回 false 表示后端正忙（409），
     * 调用方应停止整批；其它单条失败只记为不通 / 测速失败，不中断整批。
     */
    const runSingleTest = async (row: ScanResult, kind: 'probe' | 'speed', base: string): Promise<boolean> => {
        const key = rowKey(row);
        setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: kind } }));
        const req = {
            host: row.ip,
            ip: row.resolvedIp || row.ip,
            port: row.port,
            probeHost: readProbeHost(),
            speedUrl: 'auto',
            timeoutMs: 5000,
        };
        try {
            if (kind === 'probe') {
                const res = await probeSingle(base, req);
                setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: undefined, probe: res } }));
            } else {
                const res = await speedSingle(base, req);
                setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: undefined, speed: res } }));
            }
            return true;
        } catch (e) {
            if (e instanceof Error && e.message === AGENT_BUSY_ERROR) {
                setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: undefined } }));
                return false;
            }
            // 网络失败等单条错误：记为该项失败，不弹 toast、不中断整批
            setRowTests(prev => ({
                ...prev,
                [key]: {
                    ...prev[key],
                    testing: undefined,
                    ...(kind === 'probe'
                        ? { probe: { ok: false, error: e instanceof Error ? e.message : '未知错误' } }
                        : { speed: { ok: false, error: e instanceof Error ? e.message : '未知错误' } }),
                },
            }));
            return true;
        }
    };

    const uniqueRegions: string[] = Array.from(new Set(scanResults.map(r => r.colo))).filter((r): r is string => !!r).sort();
    const uniquePorts: number[] = Array.from(new Set(scanResults.map(r => r.port))).sort((a, b) => a - b);
    const uniqueSources: SourceKind[] = Array.from(new Set(scanResults.map(r => r.source).filter((s): s is SourceKind => !!s)));

    // 结果首次就绪时，默认将全部地区/端口/来源选入集合（真正全选，而非空集代表全选）
    useEffect(() => {
        if (!filterInitialized.current && uniqueRegions.length > 0) {
            setSelectedRegions(new Set(uniqueRegions));
            setSelectedPorts(new Set(uniquePorts.map(String)));
            setSelectedSources(new Set(uniqueSources.length > 0 ? uniqueSources : (['cf', 'cm', 'domain', 'third'] as SourceKind[])));
            filterInitialized.current = true;
        }
    }, [uniqueRegions, uniquePorts]);

    // 加载已保存场景名列表，供场景录入框快速选择
    useEffect(() => {
        const load = async () => {
            try {
                const data = await getScenes();
                setScenes(data.map((s) => s.name));
            } catch {
                // 加载失败不影响录入
            }
        };
        load();
    }, []);

    // 点击下拉外部时关闭场景选择浮层
    useEffect(() => {
        if (!sceneDropdownOpen) return;
        const handler = (e: MouseEvent) => {
            if (sceneInputRef.current && !sceneInputRef.current.contains(e.target as Node)) {
                setSceneDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [sceneDropdownOpen]);

    // 已保存场景列表，不进行过滤，全部展示为标签
    const sceneOptions = scenes;

    const latencyTrim = latencyFilterValue.trim();
    const isLatencyFormatValid = /^\d+$/.test(latencyTrim);
    const effectiveLatencyValue = isLatencyFormatValid ? parseInt(latencyTrim, 10) : 0;

    const ipsPerRegionTrim = ipsPerRegion.trim();
    const isIpsPerRegionFormatValid = /^\d+$/.test(ipsPerRegionTrim) && parseInt(ipsPerRegionTrim, 10) >= 1;
    const effectiveIpsPerRegion = isIpsPerRegionFormatValid ? parseInt(ipsPerRegionTrim, 10) : DEFAULT_IPS_PER_REGION;

    const baseFilteredResults = scanResults.filter(r => isLatencyFilterEnabled
        ? (isLatencyFormatValid && r.latency > -1 && r.latency <= effectiveLatencyValue)
        : true
    );

    const portCounts = baseFilteredResults.reduce((acc, r) => {
        const key = String(r.port);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    // 按端口筛选：仅保留 selectedPorts 中的端口
    const portFilteredResults = baseFilteredResults.filter(r =>
        selectedPorts.has(String(r.port))
    );

  const regionCounts = portFilteredResults.reduce((acc, r) => {
        if (r.colo) {
            acc[r.colo] = (acc[r.colo] || 0) + 1;
        }
        return acc;
    }, {} as Record<string, number>);

    const filteredResults = portFilteredResults.filter(r =>
        r.colo ? selectedRegions.has(r.colo) : true
    ).filter(r =>
        r.source ? selectedSources.has(r.source) : true
    );

    let limitedResults = [...filteredResults];
    if (isRegionLimitEnabled) {
        const regionCountsForLimit: { [key: string]: number } = {};
        limitedResults = filteredResults.filter(r => {
            const colo = r.colo || 'Unknown';
            regionCountsForLimit[colo] = (regionCountsForLimit[colo] || 0) + 1;
            return regionCountsForLimit[colo] <= effectiveIpsPerRegion;
        });
    }

    // ---------- 批量测试：勾选 + 全选 ----------
    const checkedVisibleCount = limitedResults.filter(r => checkedKeys.has(rowKey(r))).length;
    const allVisibleChecked = limitedResults.length > 0 && checkedVisibleCount === limitedResults.length;
    const toggleSelectAllVisible = () => {
        if (allVisibleChecked) {
            setCheckedKeys(prev => {
                const next = new Set(prev);
                for (const r of limitedResults) next.delete(rowKey(r));
                return next;
            });
        } else {
            setCheckedKeys(prev => {
                const next = new Set(prev);
                for (const r of limitedResults) next.add(rowKey(r));
                return next;
            });
        }
    };
    const toggleRowChecked = (row: ScanResult) => {
        const key = rowKey(row);
        setCheckedKeys(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    /** 一键批量测试：只测已勾选且当前可见的行，最多 4 个并发 */
    const runBatch = async (kind: 'probe' | 'speed') => {
        if (batchKind) return;
        const targets = limitedResults.filter(r => checkedKeys.has(rowKey(r)));
        if (targets.length === 0) {
            showToast('请先勾选要测试的 IP', 'warning');
            return;
        }
        const base = await getAgentBase();
        if (!base) return;
        if (await checkBusy(base)) return;
        setBatchKind(kind);
        setBatchDone(0);
        setBatchTotal(targets.length);
        const busy = { value: false };
        let idx = 0;
        const worker = async () => {
            while (idx < targets.length && !busy.value) {
                const row = targets[idx++];
                const ok = await runSingleTest(row, kind, base);
                if (!ok) {
                    busy.value = true;
                    break;
                }
                setBatchDone(d => d + 1);
            }
        };
        try {
            await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));
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
            showToast(`测速完成：共 ${targets.length} 个`, 'success');
        }
    };

    const handleSave = async () => {
        if (filteredResults.length === 0) {
            showToast('没有可保存的结果。', 'warning');
            return;
        }

        if (!sceneName.trim()) {
            showToast('请输入场景名称', 'warning');
            return;
        }

        setIsSaving(true);
        try{
            const dataToSave = limitedResults.map(({ isAvailable, ...rest }) => rest);
            await saveResults(sceneName.trim(), dataToSave as ScanResult[], saveMode);
            showToast(`场景 "${sceneName.trim()}" 保存成功！\n共 ${limitedResults.length} 个IP/域名\n模式: ${saveMode === 'overwrite' ? '覆盖' : '追加'}`, 'success');
            if (onSaveSuccess) onSaveSuccess();
        } catch (error) {
            console.error('Failed to save results:', error);
            showToast(`保存失败: ${error instanceof Error ? error.message : '未知错误'}`, 'error');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-3 mb-4">
                <ListFilter className="w-7 h-7 text-purple-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">扫描结果</h2>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">仅展示本地后端回传的达标结果：延迟 3 次取最好一次 ≤ 延迟上限，且丢包 ≤ 丢包上限。</p>
            {scanResults.length > 0 ? (
                <>
                    <div className="p-3 mb-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
                        <div className="flex items-center justify-between gap-4 mb-4 pb-3 border-b border-gray-200 dark:border-gray-600">
                            <div className="flex items-center gap-4 flex-wrap">
                                <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">筛选与操作:</h3>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="latency-filter-enable"
                                        type="checkbox"
                                        checked={isLatencyFilterEnabled}
                                        onChange={(e) => {
                                            if (e.target.checked && !isLatencyFormatValid) {
                                                setLatencyFilterError('请输入有效的正整数');
                                                return;
                                            }
                                            setLatencyFilterError('');
                                            setIsLatencyFilterEnabled(e.target.checked);
                                        }}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                    <label htmlFor="latency-filter-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">延迟 ≤</label>
                                </div>                                
                                 <div className="flex items-center gap-2">
                                    <input
                                        id="latency-filter-value"
                                        type="text"
                                        value={latencyFilterValue}
                                        onChange={(e) => { setLatencyFilterValue(e.target.value); if (latencyFilterError) setLatencyFilterError(''); }}
                                        className="p-1 border rounded-md w-20 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white disabled:bg-gray-200 dark:disabled:bg-gray-800"
                                        disabled={!isLatencyFilterEnabled}
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">ms</span>
                                    {latencyFilterError && <span className="text-red-500 text-xs">{latencyFilterError}</span>}
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="region-limit-enable"
                                        type="checkbox"
                                        checked={isRegionLimitEnabled}
                                        onChange={(e) => {
                                            if (e.target.checked && !isIpsPerRegionFormatValid) {
                                                setIpsPerRegionError('请输入大于等于1的整数');
                                                return;
                                            }
                                            setIpsPerRegionError('');
                                            setIsRegionLimitEnabled(e.target.checked);
                                        }}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                    />
                                    <label htmlFor="region-limit-enable" className="text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none">每个地区保留</label>
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="ips-per-region"
                                        type="text"
                                        value={ipsPerRegion}
                                        onChange={(e) => { setIpsPerRegion(e.target.value); if (ipsPerRegionError) setIpsPerRegionError(''); }}
                                        className="p-1 border rounded-md w-20 text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white disabled:bg-gray-200 dark:disabled:bg-gray-800"
                                        disabled={!isRegionLimitEnabled}
                                    />
                                    <span className="text-sm text-gray-600 dark:text-gray-300">个</span>
                                    {ipsPerRegionError && <span className="text-red-500 text-xs">{ipsPerRegionError}</span>}
                                </div>
                            </div>
                            {/* 批量测试：只测已勾选的行，最多 4 个并发 */}
                            <div className="flex items-center gap-2 shrink-0 flex-wrap">
                                <span className="text-xs text-gray-500 dark:text-gray-400">已勾选 {checkedVisibleCount} 个</span>
                                <button
                                    type="button"
                                    onClick={toggleSelectAllVisible}
                                    disabled={limitedResults.length === 0}
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {allVisibleChecked ? '取消全选' : '全选'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void runBatch('probe')}
                                    disabled={batchKind !== null}
                                    className="px-3 py-1 text-xs font-medium text-teal-800 bg-teal-100 rounded-full hover:bg-teal-200 dark:bg-teal-900 dark:text-teal-300 dark:hover:bg-teal-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {batchKind === 'probe' ? `探针复检中 ${batchDone}/${batchTotal}…` : '一键探针复检'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void runBatch('speed')}
                                    disabled={batchKind !== null}
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {batchKind === 'speed' ? `下载测速中 ${batchDone}/${batchTotal}…` : '一键测下载速度'}
                                </button>
                            </div>
                        </div>

                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">按地区筛选</h3>
                            <div className="flex items-center gap-3">
                                <button 
                                    onClick={() => setSelectedRegions(new Set(uniqueRegions))}
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                                >
                                    全选
                                </button>
                                <button 
                                    onClick={() => setSelectedRegions(new Set())}
                                    className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                                >
                                    清空
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {uniqueRegions.map(region => {
                                const countForRegion = regionCounts[region] || 0;
                                const displayCount = isRegionLimitEnabled ? Math.min(countForRegion, effectiveIpsPerRegion) : countForRegion;
                                const isSelected = selectedRegions.has(region);
                                return (
                                    <button
                                        key={region}
                                        type="button"
                                        onClick={() => {
                                            const newSet = new Set(selectedRegions);
                                            if (newSet.has(region)) {
                                                newSet.delete(region);
                                            } else {
                                                newSet.add(region);
                                            }
                                            setSelectedRegions(newSet);
                                        }}
                                        className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                                            isSelected
                                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                                : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                        }`}
                                    >
                                        <RegionDisplay colo={region} flagSize="xs" /> <span>({displayCount})</span>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="flex items-center justify-between mb-2 mt-4">
                            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">按来源筛选</h3>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setSelectedSources(new Set((['cf', 'cm', 'domain', 'third'] as SourceKind[])))}
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                                >
                                    全选
                                </button>
                                <button
                                    onClick={() => setSelectedSources(new Set())}
                                    className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                                >
                                    清空
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {(['cf', 'cm', 'domain', 'third'] as SourceKind[]).map((src) => {
                                const countForSource = baseFilteredResults.filter(r => r.source === src).length;
                                const isSelected = selectedSources.has(src);
                                return (
                                    <button
                                        key={src}
                                        type="button"
                                        onClick={() => {
                                            const newSet = new Set(selectedSources);
                                            if (newSet.has(src)) newSet.delete(src);
                                            else newSet.add(src);
                                            setSelectedSources(newSet);
                                        }}
                                        className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                                            isSelected
                                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                                : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                        }`}
                                    >
                                        {SOURCE_LABELS[src]} <span className="opacity-60">({countForSource})</span>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="flex items-center justify-between mb-2 mt-4">
                            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200">按端口筛选</h3>
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setSelectedPorts(new Set(uniquePorts.map(String)))}
                                    className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                                >
                                    全选
                                </button>
                                <button
                                    onClick={() => setSelectedPorts(new Set())}
                                    className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                                >
                                    清空
                                </button>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {uniquePorts.map((port) => {
                                const portStr = String(port);
                                const isSelected = selectedPorts.has(portStr);
                                return (
                                    <button
                                        key={port}
                                        type="button"
                                        onClick={() => {
                                            const newSet = new Set(selectedPorts);
                                            if (newSet.has(portStr)) {
                                                newSet.delete(portStr);
                                            } else {
                                                newSet.add(portStr);
                                            }
                                            setSelectedPorts(newSet);
                                        }}
                                        className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                                            isSelected
                                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60'
                                                : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                                        }`}
                                    >
                                        {port} <span className="opacity-60">({portCounts[portStr] || 0})</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="max-h-96 overflow-y-auto">
                    <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0">
                            <tr>
                                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">
                                    <input
                                        type="checkbox"
                                        aria-label="全选当前可见结果"
                                        checked={allVisibleChecked}
                                        ref={el => { if (el) el.indeterminate = limitedResults.length > 0 && checkedVisibleCount > 0 && checkedVisibleCount < limitedResults.length; }}
                                        onChange={toggleSelectAllVisible}
                                        disabled={limitedResults.length === 0}
                                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500 disabled:opacity-50"
                                    />
                                </th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">IP/域名</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">来源</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">端口</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">3次延迟 (ms)</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">最好延迟 (ms)</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">丢包</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">抖动</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">复检结果</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                            {limitedResults.map((row) => {
                                const { ip, port, latency, colo, domain, latencies, lossPct, jitterMs, source } = row;
                                const key = `${ip}:${port}`;
                                const t = rowTests[key];
                                return (
                                <tr key={key} className="hover:bg-gray-100 dark:hover:bg-gray-700">
                                    <td className="px-3 py-4 whitespace-nowrap">
                                        <input
                                            type="checkbox"
                                            aria-label={`勾选 ${ip}:${port}`}
                                            checked={checkedKeys.has(key)}
                                            onChange={() => toggleRowChecked(row)}
                                            className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                                        />
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900 dark:text-white">
                                        {ip}
                                        {domain && <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">域名</span>}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{source ? SOURCE_LABELS[source] : '-'}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{port}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{latencies && latencies.length > 0 ? latencies.join(' / ') : '-'}</td>
                                    <td className={`px-6 py-4 whitespace-nowrap text-sm font-bold ${getLatencyColor(latency)}`}>{latency > -1 ? `${latency}ms` : 'N/A'}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{lossPct !== undefined ? `${lossPct}%` : '-'}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{jitterMs !== undefined ? `${jitterMs}ms` : '-'}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{colo ? <RegionDisplay colo={colo} flagSize="sm" /> : '-'}</td>
                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                        <div className="flex flex-col gap-1">
                                            {t?.testing === 'probe' && <span className="text-teal-600">探针中…</span>}
                                            {t?.testing === 'speed' && <span className="text-blue-600">下载测速中…</span>}
                                            {t?.probe && (
                                                <span className={t.probe.ok ? 'text-green-600' : 'text-red-600'}>
                                                    {t.probe.ok
                                                        ? `通${t.probe.colo ? ` ${t.probe.colo}` : ''}${t.probe.latencyMs !== undefined ? ` ${t.probe.latencyMs}ms` : ''}`
                                                        : '不通'}
                                                </span>
                                            )}
                                            {t?.speed && (
                                                <span className={t.speed.ok ? 'text-blue-600' : 'text-red-600'}>
                                                    {t.speed.ok && t.speed.speedMbps !== undefined
                                                        ? `${t.speed.speedMbps.toFixed(1)} MB/s`
                                                        : `测速失败${t.speed.error ? `（${t.speed.error}）` : ''}`}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
           
                <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600">
                    <div className="flex items-center gap-3 mb-4">
                        <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200">保存结果</h3>
                        <span className="px-2.5 py-0.5 bg-green-100 text-green-800 text-sm font-semibold rounded-full dark:bg-green-900 dark:text-green-300">IP {limitedResults.filter(r => !r.domain).length} 个</span>
                        <span className="px-2.5 py-0.5 bg-indigo-100 text-indigo-800 text-sm font-semibold rounded-full dark:bg-indigo-900 dark:text-indigo-300">域名 {limitedResults.filter(r => r.domain).length} 个</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="relative" ref={sceneInputRef}>
                            <input 
                                id="scene-name"
                                type="text" 
                                value={sceneName}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    setSceneName(v);
                                    // 自行输入内容后隐藏下拉，清空则重新展开
                                    setSceneDropdownOpen(v.trim() === '');
                                }}
                                onFocus={() => setSceneDropdownOpen(true)}
                                placeholder="场景名称，例如: 家庭电信"
                                className="p-2 border rounded-md w-64 dark:bg-gray-600 dark:border-gray-500 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                            {sceneDropdownOpen && (
                                <div className="absolute z-30 mt-1 w-64 max-h-56 overflow-auto rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg p-2">
                                    {sceneOptions.length > 0 ? (
                                        <div className="flex flex-wrap gap-1.5">
                                            {sceneOptions.map((name) => (
                                                <button
                                                    key={name}
                                                    type="button"
                                                    onClick={() => { setSceneName(name); setSceneDropdownOpen(false); }}
                                                    className="px-2.5 py-1 text-xs font-medium rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300 dark:bg-indigo-900/40 dark:text-indigo-200 dark:border-indigo-700/60 dark:hover:bg-indigo-800/60 transition-colors"
                                                >
                                                    {name}
                                                </button>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="px-1 py-2 text-xs text-gray-400 dark:text-gray-500">
                                            暂无已保存场景
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        
                        <div className="relative flex w-fit items-center rounded-lg bg-gray-100 p-1 dark:bg-gray-700 border border-gray-200 dark:border-gray-600">
                            <button
                                onClick={() => setSaveMode('overwrite')}
                                className={`relative z-10 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                                    saveMode === 'overwrite'
                                        ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                        : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                                }`}
                            >
                                覆盖同场景数据
                            </button>
                            <button
                                onClick={() => setSaveMode('append')}
                                className={`relative z-10 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                                    saveMode === 'append'
                                        ? 'bg-white text-gray-800 shadow-sm dark:bg-gray-900 dark:text-white'
                                        : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-white'
                                }`}
                            >
                                追加到旧数据
                            </button>
                        </div>

                        <button
                            onClick={handleSave}
                            disabled={isSaving || filteredResults.length === 0 || !sceneName.trim()}
                            className="flex items-center bg-blue-600 text-white font-bold py-2 px-6 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                        >
                            <Save className="w-4 h-4 mr-2" />
                            {isSaving ? '保存中...' : '保存'}
                        </button>
                    </div>
                </div>
                </>
            ) : (
                <p className="text-gray-500 dark:text-gray-400 text-center">暂无测试结果数据</p>
            )}
        </div>
    );
}
