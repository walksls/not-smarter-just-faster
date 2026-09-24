# ⭐ 发现：「喜欢猜」是可量化的，而且与"智力"差异直接相关

> 来源：用户观察（2026-09-25）——「deepseek-v4.1-flash 非常喜欢猜，猜了半天自己找个方向
> 闷头撞过去…我怀疑这正是为什么我们的改法只能提高速度、不能提高智力」。
> 下面用**马里奥实验的既有数据**（¥0，无需新跑）验证这个观察。

## 1. 行为差异：先查 vs 直接下手

| 臂 | 首次写操作前**真正读取**的次数 | web_search | web_fetch |
|---|---:|---:|---:|
| base/run1 | **54** | 1 | 5 |
| base/run2 | **30** | — | — |
| base/run3 | 2 | — | — |
| **we-need**/run1,2,3 | **6 / 2 / 4** | **0** | **0** |
| we-need 旧锚定/1,2,3 | 6 / 6 / 8 | **0** | **0** |

**中位数：base 30 次 vs we-need 6 次。**

**base/run1 前 20 步在干什么**（全是查权威资料）：
```
 7. web_search  "Super Mario Bros NES physics constants disassembly gravity 0020"
 9. web_fetch   tasvideos.org/GameResources/NES/SuperMarioBros.html   ← 逐帧物理数据
10. bash        下载 justinmeister/Mario-Level-1 的真实关卡数据
18. bash        curl 下载 WorldFoundry 的 smb_w1_1 关卡
```

**we-need/run1 前 14 步**：
```
 1-5. 探环境（ls / env / node / playwright）      ← 和 base 一样
 6.   mkdir 建目录
 7.   写 playwright 检查脚本
 8.   ★ write js/sprites.js   ← 第 8 步就开始写代码了
10-14. write levels.js / audio.js / entities.js   ← 一路写下去
```
**全程 `web_search`=0、`web_fetch`=0。**

## 2. 「猜疑词」密度（中英双语统计）

⚠️ 第一次统计时 base 显示 0 —— **那是假象**：base 用英文思考，中文正则匹配不到。
补上英文对应词后（`assume/probably/maybe/guess/likely/seems`）重测：

| 臂 | 每千字符猜疑词 |
|---|---:|
| base | **0.01**（0.013 / 0.018 / 0.011）|
| we-need | **0.96**（0.79 / 0.73 / 1.37）|
| we-need 旧锚定 | **1.10**（0.86 / 1.48 / 0.95）|

**约 100 倍差异。**

## 3. 这解释了「为什么只快不聪明」

| | base | we-need |
|---|---|---|
| 前 20 步 | 查反汇编常数、抓真实关卡数据 | 探完环境立刻开写 |
| 用时 | 46–60 分 | 30 分 |
| 花费 | ¥1.14 | ¥0.55 |
| 工具调用 | 239 | 127 |
| 「猜疑词」 | 0.01/千字 | 0.96/千字 |

**we-need 快，不是因为它"想得更高效"，而是因为它"查得更少、更早动手"。**
省下的时间/调用/花费，**主要来自少做调研**——这正好是用户说的
"猜了半天自己找个方向闷头撞过去"。

⚠️ **但要诚实**：本实验**不能证明**"查得多 = 成品更好"。本次判卷里两边都是 16/16 关键词、
都能跑；base 反而有 1/2 有效样本是白屏 bug（`lv.kinds.charAt`），we-need 3/3 能跑。
**所以"少查"在这一个任务上没有表现出质量损失**——也可能是因为"马里奥"这个任务
**不需要**精确的物理常数（差不多就行），而在**需要精确性**的任务上，"少查"才会致命。

→ **这是本次发现最该继续验的点**：换一个**必须查准**的任务（如真实 API 对接、
依赖特定版本行为的 bug 修复），再比一次"先查 vs 先猜"。

## 4. 复现命令（¥0，读既有数据）

```sh
cd <实验目录>
# 首次写操作前读了几次 / 猜疑词密度 / web_search 次数
python3 - <<'PY'
import json,subprocess,re
for a in ['base','weneed-notemp']:
    raw=subprocess.run(['zstd','-d','-c','--',f'runs/{a}/run1/session.zstd'],capture_output=True).stdout.decode('utf-8','replace')
    calls=[]
    for l in raw.splitlines():
        try: j=json.loads(l)
        except: continue
        if j.get('type')=='tool/call': calls.append(j['data'].get('name'))
    fw=next((i for i,n in enumerate(calls) if n in ('write','edit')),None)
    print(a,'首次写在第',fw,'个调用；前 20 个：',calls[:20])
PY
```
