# photos

给家人看的私人相册。索尼 A7R V 的 `.HIF` 和 iPhone 的 `.HEIC` 拖进本地的工作台，自动压成 AVIF，
推到 GitHub，几分钟后出现在 <https://photos.anning.org>。全部免费。

## 日常怎么用

双击 `start.cmd`，浏览器会打开相册工作台，然后：

1. 把照片拖进去（原始文件只在本机处理，不会上传到网上）
2. 等它解码、压缩，缩略图出来后取消勾选不想发的，方向不对的用旋转按钮修
3. 填相册名，点「发布到网站」

之后 GitHub Actions 会自动构建部署，大约一两分钟网站更新。

顶部那条容量条是 GitHub Pages 的配额。默认预算 800MB，Pages 的硬上限是 1GB，超了会**拒绝部署**，
所以快满的时候到「管理」里删掉一些旧相册。

## 首次配置

以下步骤只需要做一次。

### 1. 配置 git 身份

现在这台机器没有配 git 用户名邮箱，工具会退回到一个本地占位身份提交。想让提交显示成你自己：

```powershell
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱@example.com"
```

### 2. 创建 GitHub 仓库（已完成）

仓库是 <https://github.com/AndyUneducated/photos>，`main` 和 `gallery` 两个分支都已推送。

**仓库必须是公开的。** GitHub 的免费账户在私有仓库上不能开 Pages，这是硬限制。这也意味着照片文件
本身是公开可下载的 —— 详见下面的「隐私边界」。

git 身份只配在这个仓库里（`git config --local`），全局身份保持为空，所以共用这台电脑的人在别的
仓库里提交会被 git 直接拒绝，不会误用你的名字。但要知道 `gh` 的登录令牌存在 Windows 账户的凭据库
里，**不区分目录**：同一个 Windows 登录名在任何路径下都能用它推送。想真正隔离只能分开 Windows 账户。

### 3. 打开 GitHub Pages（已完成）

Source 已设为 **GitHub Actions**，不是 "Deploy from a branch" —— 本项目要从 `main` 和 `gallery`
两个分支合并构建，分支模式做不到。

### 4. 配置 DNS —— 只剩这一步

`anning.org` 的 DNS 托管在 `ns-cloud-d1`～`d4.googledomains.com`，也就是 Squarespace 收购
Google Domains 后沿用的那套服务。入口在 Squarespace 的域名面板：**Domains → anning.org → DNS**。

添加一条记录：

| 字段 | 填什么 |
| --- | --- |
| Type | `CNAME` |
| Host / Name | `photos` |
| Value / Target | `andyuneducated.github.io` |
| TTL | 默认即可 |

容易踩的坑：

- Host 只填 `photos`，不要填 `photos.anning.org`，面板会自动补域名后缀。
- Value 只填 `andyuneducated.github.io`，**不要带仓库名**，也不要写 `github.com`。
- 如果面板要求目标以点结尾，就填 `andyuneducated.github.io.`。
- 根域名目前没有任何 A 记录，所以不存在冲突。但若 `photos` 这个子域名上还有别的记录（例如
  Squarespace 的转发占位），CNAME 会失效，GitHub 会报 `InvalidCNAMEError`。

### 5. 绑定域名（还差最后一勾）

自定义域名已经设成 `photos.anning.org`，GitHub 现在已经把 `andyuneducated.github.io/photos/`
301 跳转到它了。

DNS 生效后（通常几分钟，偶尔几小时）还要手动补一步：仓库 → **Settings → Pages**，等证书签发、
出现绿色对勾，再勾上 **Enforce HTTPS**。证书签发前访问会有证书警告，属正常现象。

### 6. 设置访问口令（已完成）

口令是 `maple-lantern-28`，仓库里只存 SHA-256，不存明文。要换的话：工作台 → 右上角「管理」→
「站点设置」→ 填「访问口令」→ 保存，下次发布时生效。

## 隐私边界（请务必读一遍）

这个站点的防护是**一道软门禁，不是加密**：

- 搜索引擎不会收录（`robots.txt` + 每页 `noindex`）
- 打开网站会要求输入口令，没输入之前一张缩略图都不会开始下载
- **但是**：口令校验发生在浏览器里，照片文件放在公开仓库里。任何人只要猜到或拿到图片 URL，
  就能绕过口令直接下载。会看网页源码的人也能绕过。

这是你在需求里明确选择的方案，因为免费 + 真正私密在 GitHub Pages 上做不到。如果哪天想要真正的
白名单登录，把 `dist/` 换成部署到 Cloudflare Pages 并套一层 Cloudflare Access 就行（也是免费的，
50 人以内），网站代码一行都不用改。

关于位置信息：**默认剥离**。只有在发布时手动勾选「公开这个相册的拍摄位置」，那个相册的照片才会带
GPS 坐标和地名。在家里拍的照片建议永远不要勾。

## 为什么照片不在 `main` 分支上

git 会永久保留它提交过的每个文件版本。如果照片放在 `main` 上，删掉一张照片**不会释放任何空间** ——
blob 留在历史里，仓库只会越来越大。

所以照片放在一个叫 `gallery` 的**孤立分支**上，每次发布都把它整体替换成一个没有父提交的新提交。
仓库体积永远等于当前相册体积。因为 git 按内容哈希去重，重新提交没变过的照片不会重复上传。

代价是本地会残留被覆盖掉的 git 对象。「管理」里的「回收本地磁盘」按钮会清掉它们
（`git reflog expire` + `git gc --prune=now`）。

## 目录结构

```
photos/
├── start.cmd              双击启动（会自动装 Node / Git / 依赖）
├── config.json            站点标题、容量预算、口令哈希、画质参数
├── MANIFEST.md            manifest.json 的数据契约
│
├── studio/                本地上传工作台（不会部署到网上）
│   ├── server.mjs         HTTP 接口，只监听 127.0.0.1
│   ├── public/            工作台界面
│   └── lib/
│       ├── heif.mjs       HEIF 解码 + colr 色彩信息解析
│       ├── color.mjs      Display P3 / BT.2020 / HLG → sRGB
│       ├── process.mjs    单张照片的完整管线
│       ├── pool.mjs       worker 线程池
│       ├── exif.mjs       EXIF 与 GPS 提取
│       ├── geocode.mjs    反向地理编码（Nominatim）
│       ├── gallery.mjs    manifest 读写、容量核算
│       └── git.mjs        孤立分支提交与推送
│
├── site/                  Astro 静态站点（部署出去的部分）
├── gallery/               照片与 manifest（gallery 分支的 worktree，不在 main 里）
├── scripts/
│   ├── setup-gallery.mjs  创建 gallery 分支和 worktree
│   ├── collect.mjs        构建后把照片并进 dist/，并校验大小和完整性
│   ├── test-decode.mjs    拿真实相机文件验证解码
│   └── test-studio.mjs    发布链路的端到端测试
└── .github/workflows/deploy.yml
```

## 技术上值得知道的几件事

**为什么不用 sharp 直接读 HEIC**：sharp 的预编译二进制不支持 HEIC。libvips 官方构建因为 H.265 的
专利问题关掉了 HEVC 支持，所以 `sharp('photo.HIF')` 会直接报不支持的格式。这里用 libheif 的
WebAssembly 版本解码，再把裸 RGBA 交给 sharp 缩放编码 —— 好处是这台机器上不需要装任何系统级依赖。

**色彩管理**：libheif 只给裸像素，不给色彩空间。所以要自己从 HEIF 容器里解析 `colr` box，识别出
Display P3 / BT.2020 / HLG / PQ，再转到 sRGB。不做这一步，iPhone 的 P3 照片会明显过饱和。
HDR（HLG/PQ）会做色调映射到 SDR，并在界面上提示你 —— 如果对结果不满意，建议在相机里导出 SDR 版本。

**方向**：libheif 会应用容器里的 `irot`/`imir` 旋转属性，但不看 EXIF 的 Orientation 标签，而不同
相机和手机写的是哪一个并不统一。所以只在能从像素尺寸确认的情况下才自动旋转，其余情况保持原样，
由界面上的旋转按钮兜底。

**并发**：一张 6100 万像素的 HEIF 解码需要几百 MB 的 WASM 堆，所以并发数按 CPU 和内存一起算，
上限 4。内存不够报错的话，在 `config.json` 里把 `concurrency` 设成 `1`。

**已知的扩展上限**：首页是一整页静态 HTML，每张照片大约占 1KB（主要是那个内联的模糊占位图）。
几百张照片时页面 200-400KB，完全没问题；如果哪天真的堆到一千多张，首页会涨到 1MB 量级，那时候
需要改成分页或者按需加载。按 800MB 预算算，理论上限大概 1600 张。

## 排查

**网站没更新** — 看仓库的 Actions 页面。如果 build 失败在 `collect`，通常是超了 1GB 配额。

**照片方向不对** — 用卡片上的 90°/180°/270° 按钮，它会带着旋转重新处理那一张。

**部署被拒 / 站点太大** — 「管理」里删旧相册，然后点「回收本地磁盘」。

**处理时内存不足** — `config.json` 里 `"concurrency": 1`。

**改了标题或口令但网站没变** — 这两项在下一次发布时才写进 manifest。想立刻生效，随便发布一次，
或者在项目目录里跑 `node -e "import('./studio/lib/gallery.mjs').then(async m => { const c = await m.loadConfig(); m.saveManifest(await m.loadManifest(c)) })"` 后手动提交 `gallery` 分支。
