import { useEffect, useMemo, useState } from 'react';
import { getScenes, getSceneResults } from '../api';
import { ScanResult } from '../utils/scanner';
import { getColoName } from '../utils/colo';
import { useToast } from './Toast';
import {
    decodeSubscription, encodeSubscription, fissionLinks, clashYaml, singboxLinks,
    parseCustomAddrs, linkRemark, renameLinkName,
    type FissionAddr, type FissionResult,
} from '../utils/fission';
import QRCode from 'qrcode';
import { Split, Copy, Download, Zap, QrCode, X } from 'lucide-react';

const NATIVE_KEY = 'CF_FISSION_NATIVE';
const SCENE_KEY = 'CF_FISSION_SCENE';
const CUSTOM_KEY = 'CF_FISSION_CUSTOM';
const NAME_PREFIX_KEY = 'CF_FISSION_NAME_PREFIX';
const NAME_REGION_KEY = 'CF_FISSION_NAME_REGION';
/** 一次裂变最多生成的节点数，防止误选几十个 IP 把订阅撑爆 */
const MAX_FISSION_LINKS = 200;

function downloadFile(filename: string, content: string) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function loadStored(key: string, fallback: string): string {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function saveStored(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* 忽略 */ }
}

export function FissionSubscription() {
    const { showToast } = useToast();
    const [scenes, setScenes] = useState<string[]>([]);
    const [scene, setScene] = useState('');
    const [items, setItems] = useState<ScanResult[]>([]);
    const [checked, setChecked] = useState<Set<string>>(() => new Set());
    const [loading, setLoading] = useState(false);
    // 裂变对象：已保存场景 / 自定义输入
    const [source, setSource] = useState<'scene' | 'custom'>('scene');
    const [customText, setCustomText] = useState(() => loadStored(CUSTOM_KEY, ''));
    const [native, setNative] = useState(() => loadStored(NATIVE_KEY, ''));
    // 原协议也可以用订阅链接拉取
    const [subLink, setSubLink] = useState('');
    const [fetchingSub, setFetchingSub] = useState(false);
    const [mode, setMode] = useState<'one' | 'all'>('one');
    // 节点命名：前缀 + 地区，如 裂变|日本|原协议名称
    const [namePrefix, setNamePrefix] = useState(() => loadStored(NAME_PREFIX_KEY, '裂变'));
    const [nameRegion, setNameRegion] = useState(() => loadStored(NAME_REGION_KEY, ''));
    const [result, setResult] = useState<FissionResult | null>(null);
    // 二维码弹窗
    const [qrTarget, setQrTarget] = useState<{ label: string; content: string } | null>(null);
    const [qrUrl, setQrUrl] = useState('');
    const [qrErr, setQrErr] = useState('');

    const itemKey = (r: ScanResult) => `${r.ip}:${r.port}`;
    const sortedItems = useMemo(
        () => [...items].sort((a, b) => a.latency - b.latency),
        [items],
    );

    const loadSceneItems = async (name: string) => {
        setLoading(true);
        try {
            const data = await getSceneResults(name);
            const sorted = [...data].sort((a, b) => a.latency - b.latency);
            setItems(sorted);
            // 默认勾选延迟最低的前 6 个（正好一对一配 6 条 Argo 协议）
            setChecked(new Set(sorted.slice(0, 6).map(itemKey)));
        } catch (e) {
            console.error('Failed to load scene results', e);
            showToast('加载场景失败', 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        getScenes()
            .then((data) => {
                const names = data.map((s) => s.name);
                setScenes(names);
                let initial = loadStored(SCENE_KEY, '');
                if (!initial || !names.includes(initial)) initial = names[0] || '';
                if (initial) {
                    setScene(initial);
                    void loadSceneItems(initial);
                }
            })
            .catch((e) => console.error('Failed to load scenes', e));
        // 只在挂载时加载一次场景列表
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSceneChange = (name: string) => {
        setScene(name);
        saveStored(SCENE_KEY, name);
        setResult(null);
        void loadSceneItems(name);
    };

    const toggleChecked = (key: string) => {
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    /** 自定义输入的解析结果（一行一个 IP 或域名，可带端口） */
    const customParsed = useMemo(() => parseCustomAddrs(customText), [customText]);

    /** 本次裂变的优选地址：场景模式用勾选的 IP（按延迟从低到高），自定义模式用输入的地址 */
    const selectedAddrs: FissionAddr[] = useMemo(() => {
        if (source === 'custom') return customParsed.addrs;
        return sortedItems
            .filter((r) => checked.has(itemKey(r)))
            .map((r) => ({
                // 域名源用解析出的实际 IP，其余用 IP 本身
                addr: r.resolvedIp || r.ip,
            }));
    }, [source, customParsed, sortedItems, checked]);

    /** 原协议支持两种给法：粘贴订阅链接拉取，或直接粘贴节点完整信息 */
    const handleFetchSub = async () => {
        const url = subLink.trim();
        if (!/^https?:\/\/\S+$/.test(url)) {
            showToast('请先填一个 http(s) 订阅链接', 'warning');
            return;
        }
        setFetchingSub(true);
        try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            const links = decodeSubscription(text);
            if (links.length === 0) throw new Error('拉到了内容，但里面没有可识别的节点链接');
            setNative(text);
            saveStored(NATIVE_KEY, text);
            showToast(`已拉取原协议订阅，共 ${links.length} 条节点`, 'success');
        } catch (e) {
            console.error('Failed to fetch subscription', e);
            showToast('拉取失败：可能是对方不允许跨域拉取或链接不对，请改成直接粘贴节点内容', 'error');
        } finally {
            setFetchingSub(false);
        }
    };

    const handleFission = () => {
        const nativeLinks = decodeSubscription(native);
        if (nativeLinks.length === 0) {
            showToast('请先粘贴原生订阅（明文链接或 base64）', 'warning');
            return;
        }
        if (source === 'custom' && customParsed.invalid.length > 0) {
            showToast(`自定义地址格式不对：${customParsed.invalid.slice(0, 3).join('、')}${customParsed.invalid.length > 3 ? '…' : ''}，请改成每行一个 IP 或域名`, 'error');
            return;
        }
        if (selectedAddrs.length === 0) {
            showToast(source === 'custom' ? '请先在自定义输入里填优选 IP 或域名' : '请先勾选要用的优选 IP', 'warning');
            return;
        }
        const argoCount = nativeLinks.filter((l) => {
            const hashIdx = l.indexOf('#');
            if (hashIdx < 0) return true;
            let remark = l.slice(hashIdx + 1);
            try { remark = decodeURIComponent(remark); } catch { /* 原样判断 */ }
            return (remark.split('丨')[0] || '') !== '直连';
        }).length;
        if (mode === 'all' && argoCount * selectedAddrs.length > MAX_FISSION_LINKS) {
            showToast(`裂变后会超过 ${MAX_FISSION_LINKS} 条节点，请减少优选地址或改用「每协议 1 个 IP」`, 'warning');
            return;
        }
        saveStored(NATIVE_KEY, native);
        // 命名：前缀|地区|原协议名称，如 裂变|日本|Argo丨Xray丨xhttp_h2；都留空则不改名
        const prefix = [namePrefix.trim(), nameRegion.trim()].filter(Boolean).join('|') || undefined;
        const r = fissionLinks(nativeLinks, selectedAddrs, mode, prefix);
        setResult(r);
        showToast(`裂变完成：${r.argoCount} 条隧道协议 × ${r.addrCount} 个优选地址，共 ${r.links.length} 条节点`, 'success');
    };

    /** 裂变后改某条节点的名称（只改备注，订阅跟着变） */
    const handleRename = (index: number, newName: string) => {
        setResult((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                links: prev.links.map((l, j) => (j === index ? renameLinkName(l, newName) : l)),
            };
        });
    };

    const subOutputs = useMemo(() => {
        if (!result) return null;
        const clash = clashYaml(result.links);
        const sb = singboxLinks(result.links);
        return {
            v2ray: encodeSubscription(result.links),
            clash,
            singbox: encodeSubscription(sb.links),
            singboxDropped: sb.dropped,
        };
    }, [result]);

    const subRows = useMemo(() => {
        if (!subOutputs || !result) return [];
        return [
            {
                key: 'v2ray',
                label: 'V2Ray',
                desc: '通用订阅 · V2RayN 等',
                content: subOutputs.v2ray,
                file: 'nexus-fission-v2ray.txt',
            },
            {
                key: 'shadowrocket',
                label: 'Shadowrocket',
                desc: 'iOS 小火箭 · 与 V2Ray 订阅同内容',
                content: subOutputs.v2ray,
                file: 'nexus-fission-shadowrocket.txt',
            },
            {
                key: 'clash',
                label: 'Clash',
                desc: `YAML · Mihomo 1.19+${subOutputs.clash.skipped > 0 ? `，已跳过 ${subOutputs.clash.skipped} 条不支持的节点` : ''}`,
                content: subOutputs.clash.yaml,
                file: 'nexus-fission-clash.yaml',
            },
            {
                key: 'singbox',
                label: 'sing-box',
                desc: subOutputs.singboxDropped > 0
                    ? `已去掉 ${subOutputs.singboxDropped} 条不支持的节点（xhttp、VLESS 加密层）`
                    : 'vless 链接 base64，与 V2Ray 同格式',
                content: subOutputs.singbox,
                file: 'nexus-fission-singbox.txt',
            },
        ];
    }, [subOutputs, result]);

    const copyText = async (text: string, okMsg: string) => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(okMsg, 'success');
        } catch {
            showToast('复制失败，请检查浏览器权限', 'error');
        }
    };

    /** 生成二维码：先用 M 级容错，放不下再降到 L 级；还放不下就提示改用复制 */
    const openQr = async (label: string, content: string) => {
        if (!content) {
            showToast('暂无可生成的内容', 'warning');
            return;
        }
        setQrTarget({ label, content });
        setQrUrl('');
        setQrErr('');
        const levels: Array<'M' | 'L'> = ['M', 'L'];
        for (const level of levels) {
            try {
                const url = await QRCode.toDataURL(content, { errorCorrectionLevel: level, margin: 1, width: 280 });
                setQrUrl(url);
                return;
            } catch {
                // 换更低的容错级别再试
            }
        }
        setQrErr('内容太长，二维码放不下，请减少节点数后重试，或直接用复制。');
    };

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-3 mb-2">
                <Split className="w-7 h-7 text-purple-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">裂变订阅</h2>
                <span className="px-2.5 py-0.5 bg-purple-100 text-purple-800 text-sm font-semibold rounded-full dark:bg-purple-900 dark:text-purple-300">原生 × 优选 IP</span>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                从已保存的场景里挑优选 IP，或者自己填 IP / 域名，一键裂变原生节点，再一键生成订阅。裂变只换链接里的地址，UUID、SNI、路径都不变；直连节点不裂变，原样跟上。订阅在浏览器本地生成，不上传服务器。
            </p>

            {/* ① 优选地址 */}
            <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">① 选择优选地址</h3>
            <div className="flex flex-wrap items-center gap-4 mb-3">
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                    <input
                        type="radio"
                        name="fission-source"
                        checked={source === 'scene'}
                        onChange={() => setSource('scene')}
                        className="text-purple-600 focus:ring-purple-500"
                    />
                    <span className="font-medium">用已保存场景</span>
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                    <input
                        type="radio"
                        name="fission-source"
                        checked={source === 'custom'}
                        onChange={() => setSource('custom')}
                        className="text-purple-600 focus:ring-purple-500"
                    />
                    <span className="font-medium">自定义输入</span>
                </label>
            </div>

            {source === 'scene' ? (
                <>
                    <div className="flex flex-wrap items-center gap-3 mb-3">
                        <select
                            value={scene}
                            onChange={(e) => handleSceneChange(e.target.value)}
                            className="p-2 border rounded-md dark:bg-gray-600 dark:border-gray-500 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        >
                            {scenes.length === 0 && <option value="">暂无已保存场景</option>}
                            {scenes.map((name) => (
                                <option key={name} value={name}>{name}</option>
                            ))}
                        </select>
                        <span className="text-sm text-gray-500 dark:text-gray-400">已勾选 {selectedAddrs.length} 个</span>
                        <button
                            type="button"
                            onClick={() => setChecked(new Set(sortedItems.slice(0, 6).map(itemKey)))}
                            className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                        >
                            取延迟最低 6 个
                        </button>
                        <button
                            type="button"
                            onClick={() => setChecked(new Set(sortedItems.map(itemKey)))}
                            className="px-3 py-1 text-xs font-medium text-blue-800 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                        >
                            全选
                        </button>
                        <button
                            type="button"
                            onClick={() => setChecked(new Set())}
                            className="px-3 py-1 text-xs font-medium text-gray-800 bg-gray-100 rounded-full hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                        >
                            清空
                        </button>
                    </div>
                    <div className="overflow-auto border border-gray-200 dark:border-gray-600 rounded-lg mb-6" style={{ maxHeight: '260px' }}>
                        {loading ? (
                            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-6">加载中…</p>
                        ) : sortedItems.length === 0 ? (
                            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-6">这个场景里没有已保存的 IP，请先去上面扫描并保存</p>
                        ) : (
                            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                                <thead className="bg-gray-50 dark:bg-gray-700 sticky top-0 z-10">
                                    <tr>
                                        <th className="px-4 py-2 text-left"><span className="text-xs font-medium text-gray-500 dark:text-gray-300">选用</span></th>
                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300">IP / 域名</th>
                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300">端口</th>
                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300">机房</th>
                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300">延迟</th>
                                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-300">丢包</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                                    {sortedItems.map((r) => {
                                        const key = itemKey(r);
                                        return (
                                            <tr key={key} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                                <td className="px-4 py-2">
                                                    <input
                                                        type="checkbox"
                                                        checked={checked.has(key)}
                                                        onChange={() => toggleChecked(key)}
                                                        className="rounded text-purple-600 focus:ring-purple-500 h-4 w-4"
                                                    />
                                                </td>
                                                <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-200">{r.resolvedIp && r.resolvedIp !== r.ip ? `${r.ip} → ${r.resolvedIp}` : r.ip}</td>
                                                <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-200">{r.port}</td>
                                                <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-200">{r.colo ? `${r.colo} ${getColoName(r.colo)}` : '-'}</td>
                                                <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-200">{r.latency}ms</td>
                                                <td className="px-4 py-2 text-sm text-gray-700 dark:text-gray-200">{r.lossPct !== undefined ? `${r.lossPct}%` : '-'}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        )}
                    </div>
                </>
            ) : (
                <div className="mb-6">
                    <textarea
                        value={customText}
                        onChange={(e) => {
                            setCustomText(e.target.value);
                            saveStored(CUSTOM_KEY, e.target.value);
                        }}
                        rows={5}
                        placeholder={'一行一个 IP 或域名，可带端口，例如：\n172.64.52.28\n104.18.12.34:2053\ncf.090227.xyz'}
                        className="w-full p-3 border rounded-md font-mono text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none mb-2"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        已识别 {customParsed.addrs.length} 个地址（最多 20 个，去重后计）。
                        带端口时裂变会连端口一起换，不带端口则沿用原生链接的端口。
                        {customParsed.truncated ? '超过 20 个的部分已忽略。' : ''}
                    </p>
                    {customParsed.invalid.length > 0 && (
                        <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                            格式不对：{customParsed.invalid.slice(0, 3).join('、')}{customParsed.invalid.length > 3 ? ` 等 ${customParsed.invalid.length} 行` : ''}，请改成每行一个 IP 或域名。
                        </p>
                    )}
                </div>
            )}

            {/* ② 原协议节点（裂变对象） */}
            <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">② 原协议节点</h3>
            <div className="flex gap-2 mb-2">
                <input
                    type="text"
                    value={subLink}
                    onChange={(e) => setSubLink(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleFetchSub();
                    }}
                    placeholder="或者粘贴订阅链接，如 https://面板域名/xxx/raw，点右边拉取"
                    className="flex-1 min-w-0 p-2 border rounded-md font-mono text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                />
                <button
                    type="button"
                    onClick={() => void handleFetchSub()}
                    disabled={fetchingSub || !subLink.trim()}
                    className="shrink-0 px-4 py-2 text-sm font-medium text-white bg-purple-600 rounded-md hover:bg-purple-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                    {fetchingSub ? '拉取中…' : '拉取订阅'}
                </button>
            </div>
            <textarea
                value={native}
                onChange={(e) => {
                    setNative(e.target.value);
                    saveStored(NATIVE_KEY, e.target.value);
                }}
                rows={4}
                placeholder="或者直接粘贴节点完整信息：明文链接（一行一条）或 base64 订阅内容。6 条 Argo 隧道链接会被裂变，直连链接原样保留。"
                className="w-full p-3 border rounded-md font-mono text-sm dark:bg-gray-600 dark:border-gray-500 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none mb-2"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">
                两种给法都行：上面填订阅链接点拉取，或下面直接粘贴节点。只存在浏览器本地，下次打开不用再贴。节点名称只按命名规则来：前缀|地区|原协议名称，不再追加机房、延迟。场景模式的端口沿用原生链接的端口。
            </p>

            {/* ③ 分配方式 + 节点命名 */}
            <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">③ 分配方式</h3>
            <div className="flex flex-col gap-2 mb-4">
                <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                    <input
                        type="radio"
                        name="fission-mode"
                        checked={mode === 'one'}
                        onChange={() => setMode('one')}
                        className="mt-0.5 text-purple-600 focus:ring-purple-500"
                    />
                    <span><span className="font-medium">每协议 1 个 IP</span><span className="text-gray-500 dark:text-gray-400">：按延迟顺序一对一分配，IP 不够的协议保留原生地址，不断网</span></span>
                </label>
                <label className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200 cursor-pointer">
                    <input
                        type="radio"
                        name="fission-mode"
                        checked={mode === 'all'}
                        onChange={() => setMode('all')}
                        className="mt-0.5 text-purple-600 focus:ring-purple-500"
                    />
                    <span><span className="font-medium">每协议全部 IP</span><span className="text-gray-500 dark:text-gray-400">：原生 × 全部优选地址，节点数会翻倍（最多 200 条）</span></span>
                </label>
            </div>
            <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">节点命名（可选）</h3>
            <div className="flex flex-wrap items-center gap-3 mb-2">
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                    前缀
                    <input
                        type="text"
                        value={namePrefix}
                        onChange={(e) => {
                            setNamePrefix(e.target.value);
                            saveStored(NAME_PREFIX_KEY, e.target.value);
                        }}
                        placeholder="裂变"
                        className="w-28 p-2 border rounded-md dark:bg-gray-600 dark:border-gray-500 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                    地区
                    <input
                        type="text"
                        value={nameRegion}
                        onChange={(e) => {
                            setNameRegion(e.target.value);
                            saveStored(NAME_REGION_KEY, e.target.value);
                        }}
                        placeholder="日本"
                        className="w-28 p-2 border rounded-md dark:bg-gray-600 dark:border-gray-500 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                    />
                </label>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-6">
                示例：前缀填「裂变」、地区填「日本」→ 裂变|日本|Argo丨Xray丨xhttp_h2。两项都留空则不改名；裂变后每条节点的名称还能在下面单独改。
            </p>
            <button
                type="button"
                onClick={handleFission}
                disabled={loading || selectedAddrs.length === 0 || !native.trim()}
                className="flex items-center bg-purple-600 text-white font-bold py-2 px-6 rounded-md hover:bg-purple-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed mb-6"
            >
                <Zap className="w-4 h-4 mr-2" />
                一键裂变
            </button>

            {result && (
                <>
                    <div className="p-3 bg-purple-50 dark:bg-purple-900/30 rounded-lg border border-purple-200 dark:border-purple-800 mb-3">
                        <p className="text-sm text-gray-700 dark:text-gray-200">
                            裂变完成：{result.argoCount} 条隧道协议 × {result.addrCount} 个优选地址
                            {result.directCount > 0 ? `，另有 ${result.directCount} 条直连节点原样跟上` : ''}，共 {result.links.length} 条节点。
                            下面的节点名称可以直接改，改完订阅跟着变。
                        </p>
                    </div>
                    <div className="overflow-auto border border-gray-200 dark:border-gray-600 rounded-lg mb-3" style={{ maxHeight: '280px' }}>
                        {result.links.map((link, i) => (
                            <div key={`${i}-${link.slice(0, 24)}`} className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 last:border-b-0">
                                <input
                                    type="text"
                                    value={linkRemark(link)}
                                    onChange={(e) => handleRename(i, e.target.value)}
                                    className="w-full p-1 text-sm bg-transparent text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-purple-500 rounded outline-none"
                                />
                                <p className="font-mono text-xs text-gray-400 dark:text-gray-500 truncate" title={link}>{link}</p>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-3 mb-6">
                        <button
                            type="button"
                            onClick={() => void copyText(result.links.join('\n'), `已复制 ${result.links.length} 条节点链接`)}
                            className="flex items-center px-4 py-2 text-sm font-medium text-blue-800 bg-blue-100 rounded-md hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors"
                        >
                            <Copy className="w-4 h-4 mr-1" /> 复制节点链接
                        </button>
                        <button
                            type="button"
                            onClick={() => downloadFile('nexus-fission-nodes.txt', result.links.join('\n') + '\n')}
                            className="flex items-center px-4 py-2 text-sm font-medium text-gray-800 bg-gray-100 rounded-md hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors"
                        >
                            <Download className="w-4 h-4 mr-1" /> 下载节点文件
                        </button>
                    </div>

                    {/* ④ 一键生成订阅：每种客户端一行，后面跟复制和二维码 */}
                    <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">④ 一键生成订阅</h3>
                    <div className="border border-gray-200 dark:border-gray-600 rounded-lg divide-y divide-gray-200 dark:divide-gray-700 mb-2">
                        {subRows.map((row) => (
                            <div key={row.key} className="flex items-center gap-2 px-3 py-2.5">
                                <div className="w-24 shrink-0">
                                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{row.label}</p>
                                    <p className="text-xs text-gray-400 dark:text-gray-500 leading-tight">{row.desc}</p>
                                </div>
                                <input
                                    type="text"
                                    readOnly
                                    value={row.content}
                                    onFocus={(e) => e.target.select()}
                                    className="flex-1 min-w-0 p-2 border rounded-md font-mono text-xs bg-gray-50 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200 outline-none"
                                />
                                <button
                                    type="button"
                                    disabled={!row.content}
                                    onClick={() => void copyText(row.content, `${row.label}订阅已复制`)}
                                    className="shrink-0 flex items-center px-3 py-2 text-sm font-medium text-blue-800 bg-blue-100 rounded-md hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Copy className="w-4 h-4 mr-1" /> 复制
                                </button>
                                <button
                                    type="button"
                                    disabled={!row.content}
                                    onClick={() => void openQr(row.label, row.content)}
                                    title="显示二维码，打开客户端扫码导入"
                                    className="shrink-0 flex items-center px-3 py-2 text-sm font-medium text-purple-800 bg-purple-100 rounded-md hover:bg-purple-200 dark:bg-purple-900 dark:text-purple-300 dark:hover:bg-purple-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <QrCode className="w-4 h-4 mr-1" /> 二维码
                                </button>
                                <button
                                    type="button"
                                    disabled={!row.content}
                                    onClick={() => downloadFile(row.file, row.content)}
                                    title="下载订阅文件"
                                    className="shrink-0 flex items-center px-3 py-2 text-sm font-medium text-gray-800 bg-gray-100 rounded-md hover:bg-gray-200 dark:bg-gray-600 dark:text-gray-300 dark:hover:bg-gray-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Download className="w-4 h-4" />
                                </button>
                            </div>
                        ))}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                        点「二维码」会弹出大图，打开客户端扫码导入。内容太长（二位码放不下约 3KB）时会提示，节点太多就减少勾选后重新裂变，或直接用复制。
                    </p>
                </>
            )}

            {/* 二维码弹窗 */}
            {qrTarget && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
                    onClick={() => setQrTarget(null)}
                >
                    <div
                        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-full max-w-sm"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-200">{qrTarget.label} 订阅二维码</h3>
                            <button
                                type="button"
                                onClick={() => setQrTarget(null)}
                                className="p-1 rounded-md text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                                aria-label="关闭"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        {qrUrl ? (
                            <>
                                <img src={qrUrl} alt={`${qrTarget.label} 订阅二维码`} className="w-[280px] h-[280px] mx-auto rounded-md bg-white" />
                                <p className="text-xs text-gray-500 dark:text-gray-400 text-center mt-4">打开客户端扫码导入订阅</p>
                            </>
                        ) : qrErr ? (
                            <p className="text-sm text-red-600 dark:text-red-400 text-center py-10">{qrErr}</p>
                        ) : (
                            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-10">正在生成二维码…</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
