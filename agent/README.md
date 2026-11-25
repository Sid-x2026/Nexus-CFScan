# nexus-cfscan-agent

Nexus-CFScan 的本地测速后端（Go，标准库 only，无第三方依赖）。

CFData-Web 只被用作思路参考，**没有复用它的源码**；这个服务是
按 Nexus-CFScan 前端（`~/workspace/cf/src/utils/localAgent.ts`）
的接口从头写的，与前端的扫描参数一一对应。

## 运行

```bat
:: Windows：双击 build.bat，或
build.bat
cfscan-agent.exe
```

```sh
# Linux / macOS
./build.sh
./cfscan-agent
```

启动后监听 `http://127.0.0.1:13335`（被占用时自动 +1，最多试到
13344，启动日志会打印实际端口）。只绑本机回环地址，不需要令牌，
浏览器页面直接连它。

> 注意：如果你本机还在跑 CFData-Web（也是 13335），先关掉它，
> 否则这个服务会退到 13336，前端探测端口时会往后多探几个，
> 一般仍能命中；最稳妥是同一时间只跑一个。

## 接口（全部 JSON，允许任意 Origin，支持 OPTIONS）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | `{ok, service:"nexus-cfscan-agent", version, running, task}` |
| POST | `/scan` | 下发扫描任务，返回 `{ok, taskId, total}`；已有任务在跑时返回 HTTP 409 |
| GET | `/progress?since=N` | 增量取回达标结果 `{ok, taskId, running, done, total, since, count, results, startedAt, finishedAt}` |
| POST | `/stop` | 取消当前任务，返回 `{ok:true}` |

### POST /scan 参数（与前端 `AgentScanPayload` 一致）

```json
{
  "targets": [{"host": "example.com", "ip": "104.16.132.229", "port": 443}],
  "threads": 8,
  "timeoutMs": 5000,
  "latencyLimit": 180,
  "lossLimit": 10,
  "rounds": 3,
  "jitterStable": 50,
  "jitterBackup": 100,
  "scanMode": "tcping",
  "portMode": "fixed",
  "coloFilter": ["HKG", "NRT", "SIN", "ICN", "TPE"],
  "topN": 20,
  "speedUrl": "auto",
  "source": "cf"
}
```

**规则不在后端写死**：每次扫描的阈值全部取自这次请求里的
参数，前端页面上改一个数，下一次扫描就按新的来。后端只在
字段缺失时用默认值顶上（与前端 `DEFAULT_SCAN_PARAMS` 相同：
threads 8、timeoutMs 5000、latencyLimit 180、lossLimit 10、
rounds 3、jitter 50/100、topN 20、scanMode tcping、机房默认
亚洲 5 个）。

## 扫描逻辑（v1）

- 每个目标用 `threads` 大小的 worker 池并发测，`rounds` 轮。
- **tcping**：TCP 握手耗时；**httping**：HTTP(S) 首字节时间
  （TTFB，TLS 端口 443/2053/2083/2087/2096/8443 用 TLS，
  SNI 为域名 host，否则为 `speed.cloudflare.com`）。
- `latencies` = 成功的各轮延迟；`lossPct` = 失败轮数 / 总轮数；
  `latency` = 最好一次（最小值）；`jitterMs` = 最大值 − 最小值；
  `tcpMs` = 最好一次 TCP 耗时；`tlsMs` = 最好一次 TLS 握手耗时，
  未测时为 -1。
- **达标判定**（缺一不可）：至少成功 1 次；最好延迟 ≤
  `latencyLimit`；丢包率 ≤ `lossLimit`。例如 rounds=3、
  lossLimit=10 时，3 次必须全成功才算达标。
- **机房识别**：只对达标候选做一次 TLS 拨号（SNI
  `speed.cloudflare.com`）读 `/cdn-cgi/trace`，取 `colo=` /
  `loc=`。识别失败不丢结果（colo/loc 留空）；识别出机房且
  不在 `coloFilter` 里才丢弃。
- 只回传达标结果；`done`/`total` 统计的是全部已处理目标。
  增量轮询（`?since=`）按完成顺序返回，最终列表按延迟升序、
  截取前 `topN` 条（`since=0` 读已完成任务时返回该最终列表）。
- `portMode` 只接收不执行：前端已经按固定/随机选好每个
  目标的端口，后端不重选。`speedUrl` 只接收不执行：**v1 不做
  下载测速**，`speedMbps` 字段不返回；需要测速时后续版本再加。
