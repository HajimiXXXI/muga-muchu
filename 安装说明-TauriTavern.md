# TauriTavern 安装说明（给朋友看）

## 先说结论

TauriTavern 不是普通文件夹版酒馆，它是把 SillyTavern 1.18.0 的前端装进一个手机 App 里。

所以：

- 你进不去 `/data`、`/data/data`，是 Android 的正常限制，不是手机坏了。
- 系统文件管理器搜不到 `tavern`，也很正常，因为 App 的文件在自己的沙盒里。
- 不要为了装插件去 root、改权限、删 `/data` 里的东西。

官方项目：`https://github.com/Darkatse/TauriTavern`
（SillyTavern 1.18.0 前端 + Tauri/Rust 后端，Android 提供 APK 安装包。）

---

## 先记住这一条：manifest.json 必须在一层里

安装器只会到仓库**第一层**去找 `manifest.json`。

```text
对：仓库根目录直接躺着 manifest.json、index.js、style.css
错：仓库根目录只有一个文件夹 muga-muchu-1.9.1/，文件都在那里面
```

错的那种，装的时候会报：

```text
Failed to install extension: Validation error: Extension manifest.json is missing
```

**这条报错的意思是「我在第一层没找到 manifest.json」，不是「仓库里没有这个文件」，也不是你手机的问题。**

本仓库（`https://github.com/HajimiXXXI/muga-muchu`）已经把 8 个文件全放在根目录，正常不会再遇到这个报错。

---

## 最省事的安装方式：应用内 Git 安装

TauriTavern 内置了 Git，可以在界面里直接装第三方扩展，不需要命令行。

步骤：

1. 打开 TauriTavern。
2. 找到「扩展」面板（和 SillyTavern 一样的位置，通常在顶栏的扩展图标里）。
3. 点「安装扩展」。
4. 在输入框里粘贴这一行，**要填仓库根地址，别填 `/tree/...` 子目录、也别填 Release 页**：

   ```text
   https://github.com/HajimiXXXI/muga-muchu
   ```

5. 点安装，等它拉取完成。
6. 刷新页面，或重启 TauriTavern。
7. 在扩展列表里找到「无我梦中 · Muga Muchū」（目录名是英文 `muga-muchu`，列表里显示英文名是正常的）。

---

## 装完怎么确认成功

1. 扩展列表里出现「无我梦中 · Muga Muchū」。
2. 展开后能看到版本号 `v1.9.1`。
3. 能看到副标题：让厚甲的 AI 在无我之梦里，周遭尽是阿鼻叫唤。
4. 能看到六把武器：镰刀、大剑、长枪、刺剑、鞭子、锤子。
5. 点「镰刀」时，按钮会变成朱砂色的选中状态。

如果看不到，按这个顺序查：

1. 刷新页面 → 完全关闭 App 再打开。
2. 扩展是不是被禁用了。
3. 安装时有没有报错；报 `manifest.json is missing` 就是上面说的层级问题。
4. 报的是网络 / Git 相关错误，就是拉不下来，换个时间或换网络重试。

---

## 如果没有 Git 仓库地址

TauriTavern 是 App，数据在应用沙盒里，普通文件管理器进不去。

可选方向（按可行性排序，具体以你的 TauriTavern 版本界面为准）：

1. **要 Git 仓库地址**（最稳，本仓库就有）。
2. **看扩展面板里有没有「从本地文件导入」「导入 ZIP」入口**。有就直接选 ZIP——注意 ZIP 里也不能多套一层目录，解压后要让 `manifest.json` 和 `index.js` 在同一层。
3. **如果 TauriTavern 提供数据导出/导入或同步功能**，可以让对方在能访问目录的设备上装好，再通过同步带过来。
4. 以上都没有时，才考虑用电脑 adb 或 Termux 访问应用目录，这对新手不推荐。

---

## 第一次用怎么设置

```text
启用筛选：开
输出还原：开
武器：镰刀
替换方式：只换标签（推荐）
强度：轻或中
保护代码块：开
```

先不要用锤子。

---

## 这个插件是什么、不是什么

它会在消息发给 AI 之前，把部分容易触发上游检测的文字换个样子；AI 回复后，再尽量还原。

它不能：

- 让模型变得更愿意写
- 修复预设本身的问题
- 保证所有模型都不报错
- 修改你的角色卡和预设文件

它只是减少「输入文字被上游拦下」这一层的概率。
