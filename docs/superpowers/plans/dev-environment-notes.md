# 开发环境搭建笔记（真机调试）

> 这份文档记录的是**把 App 跑到真机上**踩过的所有坑和解法。
> 这个执行环境限制很多，不知道这些会浪费几个小时。

---

## 一、环境限制总览

| 限制 | 表现 | 解法 |
|---|---|---|
| 子进程管道 stdio 被禁 | jest `spawn EPERM`、Hermes 编译失败、ngrok 失败、React Native DevTools 失败 | jest 加 `--runInBand`；不要用 `expo export` 和 `--tunnel` |
| 沙箱外的家目录不可写 | Expo 报 `EPERM: mkdir 'C:\Users\mobis\.expo'` | 启动前把 `USERPROFILE` / `HOME` 指向工作区内目录 |
| 遥测写入沙箱外 | Expo 命令直接崩 | 设 `EXPO_NO_TELEMETRY=1` |
| TLS 中间人代理 | Node `unable to verify the first certificate`；curl `SEC_E_NO_CREDENTIALS`；`Invoke-WebRequest` 连接被关闭 | 用 Node 下载并加 `--use-system-ca` |
| 后台进程被回收 | adb 守护进程随命令结束而死，`adb reverse` 隧道断掉 | adb 服务必须作为**常驻后台任务**运行 |
| WMI / CIM 查询被拒 | `Get-NetIPAddress`、`Get-NetFirewallProfile`、`Get-ConnectionProfile`、`Get-PnpDevice` 全部「拒绝访问」 | 用 `ipconfig` / `netstat` / `netsh` 替代 |
| PowerShell 读中文乱码 | `Get-Content` 显示成 `璁剧疆` | 一律用 read 工具看文件，那是显示假象 |

---

## 二、真机调试的标准流程

### 1. 装 adb（一次性）

platform-tools 已解压在 `.superpowers/platform-tools/`。若需重下：

```powershell
node --use-system-ca .superpowers\download.cjs `
  'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' `
  "$env:TEMP\platform-tools.zip"
Expand-Archive "$env:TEMP\platform-tools.zip" -DestinationPath .superpowers -Force
```

### 2. 手机侧（一次性）

1. 设置 → 关于手机 → 连点「版本号」7 次
2. 设置 → 系统 → 开发者选项 → 打开 **USB 调试**
3. 数据线连电脑，手机上弹「允许 USB 调试吗？」→ 勾选**一律允许** → 允许

### 3. 常驻 adb 服务 + USB 隧道

**adb 服务必须跑在后台任务里**，否则它随命令一起被回收，隧道立刻断。

```powershell
# 后台任务 1：常驻 adb 服务
& .superpowers\platform-tools\adb.exe -L tcp:5037 nodaemon server

# 等约 12 秒（USB 枚举需要时间，查早了会是空的）
Start-Sleep 12
& .superpowers\platform-tools\adb.exe devices      # 应列出设备且状态为 device

# 建立反向隧道：手机的 127.0.0.1:8081 → 电脑的 127.0.0.1:8081，走 USB
& .superpowers\platform-tools\adb.exe reverse tcp:8081 tcp:8081
& .superpowers\platform-tools\adb.exe reverse --list   # 应显示 UsbFfs tcp:8081 tcp:8081
```

设备显示 `unauthorized` 时：看手机屏幕点「允许」；没有弹窗就去开发者选项点「撤销 USB 调试授权」再重插。

### 4. 启动 Expo（后台任务）

```powershell
$expoHome = 'C:\ccproject\gym\.superpowers\expo-home'
New-Item -ItemType Directory -Force -Path $expoHome | Out-Null
$env:USERPROFILE = $expoHome        # 关键：避开沙箱外的 ~/.expo
$env:HOME        = $expoHome
$env:EXPO_NO_TELEMETRY = '1'
npx expo start --localhost          # localhost 模式 + adb reverse
```

### 5. 拉起 App

```powershell
$adb = 'C:\ccproject\gym\.superpowers\platform-tools\adb.exe'
& $adb shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:8081"
```

### 6. 截图看效果（关键能力）

无法直接看屏幕时，用 adb 截图拉回本地：

```powershell
& $adb shell screencap -p /sdcard/s.png
& $adb pull /sdcard/s.png .superpowers\shot.png
& $adb shell rm /sdcard/s.png
```

然后用 read_image 看。**不要用 `adb exec-out screencap -p > file.png`** —— PowerShell 会破坏二进制流。

### 7. 远程操作（可选）

`adb shell input tap X Y` 点击，`adb shell input swipe X1 Y1 X2 Y2` 滑动。
截图是 1280×2800，注意换算：`实际坐标 = 显示坐标 ÷ 显示尺寸 × 实际尺寸`。

---

## 三、Expo Go 版本必须匹配 SDK

**应用商店里的 Expo Go 永远是最新版，很容易和项目 SDK 对不上。** 本项目是 **SDK 57**，而商店版当时是 SDK 58，报错：

> Project is incompatible with this version of Expo Go

**解法：装匹配版本的 Expo Go APK（不动项目代码）。**

```powershell
# 查官方接口拿下载地址
node .superpowers\expo-go-url.cjs

# 本项目用的（SDK 57 → Expo Go 57.0.9）
node --use-system-ca .superpowers\download.cjs `
  'https://github.com/expo/expo-go-releases/releases/download/Expo-Go-57.0.9/Expo-Go-57.0.9.apk' `
  .superpowers\Expo-Go-57.0.9.apk

# 直接装会因为版本降级失败，先卸再装
& $adb uninstall host.exp.exponent
& $adb install .superpowers\Expo-Go-57.0.9.apk
```

---

## 四、为什么不用局域网 / 隧道

- **局域网**：这台机器在园区网（`10.150.x`），防火墙三个 profile 全开且无入站放行规则；换网段、换 WiFi 都没用。手机浏览器访问 `http://<电脑IP>:8081/status` 一直转圈。
- **隧道（`--tunnel`）**：ngrok 是子进程，撞沙箱的 `spawn EPERM`，走不通。
- **USB + adb reverse**：数据走数据线，**不经过网络、不经过路由器、防火墙管不着**。这是本环境下唯一可行的路。

> 顺带：如果将来要放行防火墙（需管理员），规则只开一个端口，用完可撤：
> ```powershell
> New-NetFirewallRule -DisplayName "Expo Metro 8081" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow -Profile Any
> Remove-NetFirewallRule -DisplayName "Expo Metro 8081"
> ```

---

## 五、出 APK：为什么最终走的是 EAS 云构建

**结论：本地构建在这台机器上走不通，不是因为沙箱，是因为网络的下载量上限。**

### 被排除的路径

| 路径 | 失败原因 |
|---|---|
| 局域网直连 | 防火墙 Domain/Private/Public 三个 profile 全开且无入站放行规则；换网段、换 WiFi 都没用 |
| `expo start --tunnel` | ngrok 是子进程，撞沙箱的 `spawn EPERM` |
| **本地构建（Gradle）** | **网络下不动 Gradle 发行版（150MB）和 Maven 依赖（1-2GB）**。gradle.org 与它的 GitHub 镜像全部 `ECONNRESET`／挂起。**换成用户自己的终端也一样**，因为卡点是网络不是权限 |

### 关键认知

> 这个网络**能下 1MB，下不动 2GB**。
> 判断一条路能不能走，看的是"下载量"，不是"沙箱 vs 你的终端"。

云构建把这个变量消掉了：**只上传 3.1MB 源码**，Gradle 和依赖下载都发生在 Expo 的服务器上。

### EAS 云构建的完整步骤

```powershell
. .superpowers\build-env.ps1
$env:EXPO_TOKEN = '<在 expo.dev 生成的 Access Token>'
Set-Location C:\ccproject\gym

# 一次性：建立项目关联（写入 extra.eas.projectId 到 app.json）
eas init --non-interactive --force

# 构建（preview profile 产出 APK）
eas build --platform android --profile preview --non-interactive
```

实测：**上传 25 秒，云端构建约 20 分钟，产出 APK 105MB。**

### 查构建状态不用 eas-cli

`eas` 每次运行都要 spawn 子进程去读项目配置，每跑一次就得申请一次提权。查状态用 `.superpowers/eas-status.cjs` 直接打 Expo 的 GraphQL API，不需要子进程：

```powershell
$env:EXPO_TOKEN = '...'
node --use-system-ca .superpowers\eas-status.cjs fb768c8d-f89c-4041-98a2-27ebd41527a2
```

### 安装到手机

```powershell
adb install -r .superpowers\gym-tracker-preview.apk
adb shell am start -n com.ccproject.gymtracker/.MainActivity
```

### 沿路踩的坑（都记在 `build-env.ps1` 里）

1. **`spawn EPERM`**：eas-cli 必须 spawn Expo CLI 读配置。沙箱禁止子进程管道 stdio。**按规则原样重试一次并申请 `danger-full-access`** —— 这不是绕路，是文档规定的正确回应。
2. **`EPERM: mkdir ...\AppData\Roaming\eas-cli-nodejs`**：**`USERPROFILE` 重定向管不到 `APPDATA` 和 `LOCALAPPDATA`**，Windows 工具独立读它们，必须一并重定向。
3. **`EIDLETIMEOUT registry.npmjs.org`**：看着像网络挂了，其实 npm 默认空闲超时太短。放宽到 600 秒 + 5 次重试后，**30 秒装完**。

---

## 六、这个环境的通用规律（最重要的三条）

1. **报错信息几乎总是指向错误的方向。** `IO exception while downloading manifest` 其实是沙箱不让写 `~/.android`；`Failed to download any source lists` 其实是本地权限问题；`spawn EPERM` 看着像代码错，其实是环境限制。
2. **凡是"工具想把东西写到用户目录"的地方，都要预先重定向。** 已经踩到五个：`.expo`、`.android`、`.gradle`、`AppData\Roaming\eas-cli-nodejs`、`_npx` 缓存。而且 **`USERPROFILE` 不够，`APPDATA`/`LOCALAPPDATA` 要单独设**。
3. **网络对"慢连接"不友好，但不是封了。** 凡是超时类失败，先把超时和重试调大再下结论 —— npm 那次差点被误判成"网络挂了"，实际 30 秒就装完了。
