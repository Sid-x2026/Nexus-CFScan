import { useState, useEffect } from 'react';
import { getScenes, getSceneResults, saveResults, deleteScene } from '../api';
import { getLatencyColor, ScanResult, SOURCE_LABELS } from '../utils/scanner';
import {
    probeLocalAgent, probeSingle, speedSingle, DEFAULT_AGENT_PORT, AGENT_BUSY_ERROR,
    type SingleProbeResult, type SingleSpeedResult,
} from '../utils/localAgent';
import { getColoName } from '../utils/colo';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog'; // Import Trash2 and RotateCw
import { ListChecks, Trash2, RotateCw, FileText, File, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { RegionDisplay } from './RegionDisplay';

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
    // 已保存列表平时不常翻，支持收起；状态记在浏览器里，默认展开
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem('CF_SAVED_LIST_COLLAPSED') === '1'; } catch { return false; }
    });
    const { showToast } = useToast();
    const { confirm } = useConfirm();

    // ---------- 批量按需测试（勾选 + 右上角一键探针复检 / 一键测速） ----------
    interface RowTest {
        probe?: SingleProbeResult;
        speed?: SingleSpeedResult;
        testing?: 'probe' | 'speed';
    }
    const [rowTests, setRowTests] = useState<Record<string, RowTest>>({});
    /** 正在跑的批量测试：种类 + 进度（已完成 / 总数） */
    const [batchKind, setBatchKind] = useState<'probe' | 'speed' | null>(null);
    const [batchDone, setBatchDone] = useState(0);
    const [batchTotal, setBatchTotal] = useState(0);
    // 本地后端地址：首次测试时用 probeLocalAgent 自行探测并记住，
    // 与 ScannerConfig / ScannerResults 共用同一后端（默认 13335）。
    const [agentBase, setAgentBase] = useState<string | null>(null);

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

    const readProbeHost = (): string => {
        try { return (localStorage.getItem(PROBE_HOST_KEY) || '').trim(); } catch { return ''; }
    };

    /**
     * 测其中一行（不触发整轮扫描，不改动已保存数据，只显示结果）。
     * 返回 false 表示后端正忙（409），调用方应停止整批；其它单条失败
     * 只记为不通 / 测速失败，不中断整批。
     */
    const runSingleTest = async (item: FlatIpItem, kind: 'probe' | 'speed', base: string): Promise<boolean> => {
        const key = itemKey(item);
        setRowTests(prev => ({ ...prev, [key]: { ...prev[key], testing: kind } }));
        const req = {
            host: item.ip,
            ip: item.resolvedIp || item.ip,
            port: item.port,
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

    /** 一键批量测试：只测已勾选且当前可见的行，最多 4 个并发 */
    const runBatch = async (kind: 'probe' | 'speed', targets: FlatIpItem[]) => {
        if (batchKind) return;
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
                const item = targets[idx++];
                const ok = await runSingleTest(item, kind, base);
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

    const loadData = async () => {
        setLoading(true);
        setItems([]); // Clear items before loading to avoid confusion
        setRowTests({});
        setBatchKind(null);
        setBatchDone(0);
        setBatchTotal(0);
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
    const filteredItems = items.filter(i => selectedScenes.has(i.sceneName));
    const filteredItemsSorted = [...filteredItems].sort((a, b) => {
        return a.latency - b.latency;
    });

    /** 批量测试的入口：从当前可见行里取已勾选的 */
    const handleBatchClick = (kind: 'probe' | 'speed') => {
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

        const headers = ['IP地址', '端口', '3次延迟(ms)', '最好延迟(ms)', '丢包(%)', '抖动(ms)', '来源', '地区代码', '地区名称', '场景'];
        const csvContent = [
            headers.join(','),
            ...filteredItemsSorted.map(item => [
                item.ip,
                item.port,
                item.latencies && item.latencies.length > 0 ? item.latencies.join('/') : '',
                item.latency,
                item.lossPct !== undefined ? item.lossPct : '',
                item.jitterMs !== undefined ? item.jitterMs : '',
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
                    item.lossPct !== undefined ? `丢包${item.lossPct}%` : '',
                    item.jitterMs !== undefined ? `抖动${item.jitterMs}ms` : '',
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
                item.lossPct !== undefined ? `丢包${item.lossPct}%` : '',
                item.jitterMs !== undefined ? `抖动${item.jitterMs}ms` : '',
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
                        {/* 操作按使用顺序排：先选场景，再勾行测，最后删、刷新 */}
                        <div className="flex flex-wrap items-center gap-2 ml-auto">
                            <button
                                type="button"
                                onClick={() => setSelectedScenes(new Set(uniqueScenes))}
                                className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                            >
                                全选
                            </button>
                            <button
                                type="button"
                                onClick={() => setSelectedScenes(new Set())}
                                className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                            >
                                清空
                            </button>
                            <span className="w-px h-5 bg-gray-300 dark:bg-gray-600 mx-1" aria-hidden />
                            <span className="text-xs text-gray-500 dark:text-gray-400">已勾选 {selectedItems.size} 个</span>
                            {/* 批量测试：只测已勾选的行，最多 4 个并发 */}
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
                                onClick={() => handleBatchClick('speed')}
                                disabled={batchKind !== null}
                                className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {batchKind === 'speed' ? `测速中 ${batchDone}/${batchTotal}…` : '一键测速'}
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
                            <button
                                onClick={loadData}
                                className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                            >
                                <RotateCw className="w-3.5 h-3.5 mr-1 inline-block" />
                                刷新
                            </button>
                        </div>
                </div>

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
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">IP/域名</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">来源</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">端口</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">延迟</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">丢包</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">抖动</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区代码</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">地区</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">场景</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">复检结果</th>
                        </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                        {loading ? (
                            <tr><td colSpan={11} className="px-4 py-4 text-center text-gray-500">加载中...</td></tr>
                        ) : filteredItems.length === 0 ? (
                            <tr><td colSpan={11} className="px-4 py-4 text-center text-gray-500">暂无数据</td></tr>
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
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.lossPct !== undefined ? `${item.lossPct}%` : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.jitterMs !== undefined ? `${item.jitterMs}ms` : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.colo || '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.colo ? <RegionDisplay colo={item.colo} flagSize="sm" /> : '-'}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">{item.sceneName}</td>
                                    <td className="px-4 py-2 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                        {(() => {
                                            const t = rowTests[itemKey(item)];
                                            return (
                                                <div className="flex flex-col gap-1">
                                                    {t?.testing === 'probe' && <span className="text-teal-600">探针中…</span>}
                                                    {t?.testing === 'speed' && <span className="text-blue-600">测速中…</span>}
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
                                                                : '测速失败'}
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