import { useState, useEffect } from 'react';
import { CloudflareIps, getCloudflareIps, syncCloudflareIps } from '../api';
import { Cloud, RotateCw, ChevronDown, ChevronUp } from 'lucide-react';
import { useToast } from './Toast';
import { totalIps, formatIpCount } from '../utils/scanner';

interface CloudflareIpListProps {
    onDataLoaded: (data: CloudflareIps) => void;
    /** null = 全部段（默认）；数组 = 只扫选中段，空数组 = 未选任何段 */
    selectedCidrs: string[] | null;
    onSelectionChange: (next: string[] | null) => void;
}

export function CloudflareIpList({ onDataLoaded, selectedCidrs, onSelectionChange }: CloudflareIpListProps) {
    const [cfIps, setCfIps] = useState<CloudflareIps | null>(null);
    const [loading, setLoading] = useState(false);
    const { showToast } = useToast();
    // IP 段平时基本不动，默认收起来省地方；点一下展开，状态记在浏览器里
    const [collapsed, setCollapsed] = useState(() => {
        try { return localStorage.getItem('CF_IP_RANGES_COLLAPSED') !== '0'; } catch { return true; }
    });

    const loadData = async (retryCount = 3) => {
        setLoading(true);
        for (let attempt = 1; attempt <= retryCount; attempt++) {
            try {
                const cfData = await getCloudflareIps();
                setCfIps(cfData);
                if (cfData) {
                    onDataLoaded(cfData);
                }
                setLoading(false);
                return; // 成功则直接返回
            } catch (err) {
                console.error(`Failed to fetch Cloudflare IPs (attempt ${attempt}/${retryCount})`, err);
                if (attempt < retryCount) {
                    // 指数退避：1s, 2s, 3s
                    const delay = attempt * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    // 最后一次也失败，才提示用户
                    showToast('获取Cloudflare IP段失败，可点击"同步最新IP段"手动重试', 'error');
                }
            } finally {
                if (attempt === retryCount) {
                    setLoading(false);
                }
            }
        }
    };

    const handleSync = async () => {
        setLoading(true);
        try {
            const data = await syncCloudflareIps();
            setCfIps(data);
            onDataLoaded(data);
            showToast('同步成功', 'success');
        } catch (err) {
            showToast('同步Cloudflare IP失败', 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, []);

    /** 全部段（两边合起来），用于计数与全选判断 */
    const allCidrs = [...(cfIps?.ipv4_cidrs ?? []), ...(cfIps?.cm_cidrs ?? [])];
    const selectedCount = selectedCidrs === null ? allCidrs.length : selectedCidrs.length;
    const selectedTotal = selectedCidrs === null ? totalIps(allCidrs) : totalIps(selectedCidrs);

    /** 点一段：默认全选时点一下变成只选这一段；已选的点一下取消 */
    const toggleCidr = (cidr: string) => {
        if (selectedCidrs === null) {
            onSelectionChange([cidr]);
        } else if (selectedCidrs.includes(cidr)) {
            onSelectionChange(selectedCidrs.filter(c => c !== cidr));
        } else {
            onSelectionChange([...selectedCidrs, cidr]);
        }
    };

    const renderCidrChip = (cidr: string) => {
        const selected = selectedCidrs === null || selectedCidrs.includes(cidr);
        return (
            <button
                key={cidr}
                type="button"
                onClick={() => toggleCidr(cidr)}
                title={selected ? '点击取消选择此段' : '点击选择此段'}
                className={selected
                    ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-600 px-2 py-1 rounded text-xs font-mono hover:bg-indigo-200 dark:hover:bg-indigo-800/50 transition-colors'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 border border-transparent px-2 py-1 rounded text-xs font-mono hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors'}
            >{cidr}</button>
        );
    };

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-4 mb-6">
                <Cloud className="w-7 h-7 text-blue-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">IP 段库</h2>
                <button
                    onClick={handleSync}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-600 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:hover:bg-blue-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="从上游同步最新的IP段"
                >
                    <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span>{loading ? '同步中...' : '同步最新IP段'}</span>
                </button>
                <button
                    type="button"
                    onClick={() => {
                        const next = !collapsed;
                        setCollapsed(next);
                        try { localStorage.setItem('CF_IP_RANGES_COLLAPSED', next ? '1' : '0'); } catch { /* 忽略 */ }
                    }}
                    className="ml-auto flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 transition-colors"
                    title={collapsed ? '展开 IP 段列表' : '收起 IP 段列表'}
                >
                    {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
                    <span>{collapsed ? '展开' : '收起'}</span>
                </button>
            </div>

            {collapsed ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                    {cfIps ? `CF官方IP段 ${cfIps.ipv4_cidrs.length} 个 · CM整理IP段 ${cfIps.cm_cidrs.length} 个${selectedCidrs === null ? '' : ` · 已选 ${selectedCount} 段`}` : 'IP 段加载中…'}
                </p>
            ) : (
                <>
            <div className="flex flex-wrap items-center gap-2 mb-4">
                <button
                    type="button"
                    onClick={() => onSelectionChange(null)}
                    className="px-2.5 py-1 text-xs font-medium text-indigo-600 bg-indigo-100 rounded-full hover:bg-indigo-200 dark:bg-indigo-900/50 dark:text-indigo-300 dark:hover:bg-indigo-800/50 transition-colors"
                >全选</button>
                <button
                    type="button"
                    onClick={() => onSelectionChange([])}
                    className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 transition-colors"
                >清空</button>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                    {selectedCidrs === null
                        ? `全部 ${selectedCount} 段 · 共约 ${formatIpCount(selectedTotal)} 个 IP`
                        : selectedCount === 0
                            ? '未选任何段，扫描前请先选一段'
                            : `已选 ${selectedCount} 段 · 共约 ${formatIpCount(selectedTotal)} 个 IP`}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500">点一段只扫它；随机数 ≥ 段内总数时全扫，小于则随机抽。</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="font-bold text-gray-600 dark:text-gray-300">CF官方IP段</h3>
                    <span className="text-xs text-gray-400 dark:text-gray-500">cloudflare官方公布的ip段，覆盖最全</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {cfIps?.ipv4_cidrs && cfIps.ipv4_cidrs.length > 0 ? cfIps.ipv4_cidrs.map(renderCidrChip) : <p className="text-gray-400 text-xs italic">暂无数据</p>}
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="font-bold text-gray-600 dark:text-gray-300">CM整理IP段</h3>
                    <span className="text-xs text-gray-400 dark:text-gray-500">民间大佬维护IP段，测速成功率高</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {cfIps?.cm_cidrs && cfIps.cm_cidrs.length > 0 ? cfIps.cm_cidrs.map(renderCidrChip) : <p className="text-gray-400 text-xs italic">暂无数据</p>}
                  </div>
                </div>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-4">域名源与第三方源见下方：域名源默认 BestCF 域名列表，第三方源支持填链接、粘贴 IP/域名或本地上传文件。</p>
                </>
            )}
        </div>
    );
}