#!/usr/bin/env bun
// ============================================================================
// cli.tsx —— 入口分流器（读码地图）
//
// 这个文件不承载任何业务功能，只做两件事：
//   1. 环境垫片：在任何业务模块加载前修补运行时环境（内存泄漏 / TTY / 沙箱问题）
//   2. 意图分流：识别十几种启动意图，各自动态 import 最小实现后直接 return，
//      避免加载 main.tsx（连带 React/Ink 全家桶）——启动性能是这里唯一的设计目标
//
// 所有快速路径都是同一模式：
//     检查 args → 动态 import 最小依赖 → await 执行 → return
// 全部未命中才走最后的【主线】——加载完整 CLI 进 REPL。
// ============================================================================

// 【垫片 1】性能垫片必须是第一个 import：
// 在 React/OTel 捕获原生 performance 引用之前，把全局 performance 换成 JS 实现，
// 否则 JSC 的 C++ Vector 在长会话中无限增长（内存泄漏）。
import '../utils/performanceShim.js';
import { feature } from 'bun:bundle';
import { isEnvTruthy } from '../utils/envUtils.js';

// 【垫片 2】MACRO 编译期常量兜底：
// MACRO.* 正常由 `bun run dev` 或 build 在编译期注入；绕过构建直接跑本文件时
// 在这里给默认值，防止引用 undefined 崩溃。仅非正规启动路径生效。
if (typeof globalThis.MACRO === 'undefined') {
  (globalThis as any).MACRO = {
    VERSION: process.env.CLAUDE_CODE_VERSION || '2.1.888',
    BUILD_TIME: new Date().toISOString(),
    FEEDBACK_CHANNEL: '',
    ISSUES_EXPLAINER: '',
    NATIVE_PACKAGE_URL: '',
    PACKAGE_URL: '',
    VERSION_CHANGELOG: '',
  };
}

// 【垫片 3】强制 TTY（dev-only 补丁）：
// Windows 下嵌套 bun 启动时 stdin/stdout 可能不被识别为终端（缺 isTTY），
// 交互 UI 会因此拒绝启动，这里把 isTTY 硬改成 true 兜底。
if (isEnvTruthy(process.env.CLAUDE_CODE_FORCE_INTERACTIVE)) {
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    if (!stream.isTTY) {
      try {
        Object.defineProperty(stream, 'isTTY', {
          value: true,
          configurable: true,
        });
      } catch {
        // 尽力而为，失败就算了（仅 dev 场景使用）
      }
    }
  }
}

// 【垫片 4】corepack bugfix：
// corepack 的 auto-pinning 会偷偷往用户的 package.json 里加 yarnpkg 字段——
// 对一个要写用户代码的 agent 来说是污染，提前关掉。
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// 【垫片 5】远程容器堆内存：
// CLAUDE_CODE_REMOTE=true（CCR 容器环境，约定 16GB 内存）时，给后续子进程的
// NODE_OPTIONS 追加 --max-old-space-size=8192，把堆上限拉到 8GB 防大任务 OOM。
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  const existing = process.env.NODE_OPTIONS || '';
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

// ============================================================================
// Bootstrap 入口：先识别特殊旗标，再决定是否加载完整 CLI。
// 所有 import 都是动态的——让快速路径付出最小的模块求值代价。
// ============================================================================
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 【快速路径 1】--version/-v：零模块加载，直接打印编译期内联的版本号
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }

  // 非版本路径：先加载启动性能探针，之后每个分支打一个检查点（启动耗时归因）
  const { profileCheckpoint } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // 【快速路径 2】--dump-system-prompt：导出渲染完成的 system prompt 后退出。
  // 用途：prompt 敏感性评测需要在特定 commit 上提取 system prompt。
  // ant-only：外部构建里此分支被 feature 门死代码消除（DCE）。
  // 这也是研究 system prompt 组装的官方快捷方式。
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { getMainLoopModel } = await import('../utils/model/model.js');
    const modelIdx = args.indexOf('--model');
    const model = (modelIdx !== -1 && args[modelIdx + 1]) || getMainLoopModel();
    const { getSystemPrompt } = await import('../constants/prompts.js');
    const prompt = await getSystemPrompt([], model);
    console.log(prompt.join('\n'));
    return;
  }

  // 【快速路径 3】Chrome / Computer-Use 三连：
  // 本进程不进交互界面，而是作为一个 MCP server 被别的程序调用。
  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path');
    const { runClaudeInChromeMcpServer } = await import('../utils/claudeInChrome/mcpServer.js');
    await runClaudeInChromeMcpServer();
    return;
  } else if (process.argv[2] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path');
    const { runChromeNativeHost } = await import('../utils/claudeInChrome/chromeNativeHost.js');
    await runChromeNativeHost();
    return;
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const { runComputerUseMcpServer } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // 【快速路径 4】--acp：ACP（Agent Client Protocol）agent 模式 over stdio。
  // 让 Zed/Cursor 等编辑器通过标准协议把 CCB 当 agent 后端接入。
  // 注意：feature() 必须内联在 if 条件里，这是构建期死代码消除的硬要求（Bun 限制）。
  if (feature('ACP') && process.argv[2] === '--acp') {
    profileCheckpoint('cli_acp_path');
    const { runAcpAgent } = await import('../services/acp/entry.js');
    await runAcpAgent();
    return;
  }

  // 【快速路径 5】--daemon-worker=<kind>（内部命令，supervisor 拉起 worker 用）：
  // 必须排在 daemon 子命令检查之前——每个 worker 单独拉起，性能敏感。
  // 刻意不调 enableConfigs()、不初始化埋点，worker 要轻；
  // worker 真需要配置/认证时在自己 run() 内部再拿。
  if (args[0] === '--daemon-worker' || args[0]?.startsWith('--daemon-worker=')) {
    if (!feature('DAEMON')) {
      console.error(
        'Error: --daemon-worker requires DAEMON feature to be enabled. Set FEATURE_DAEMON=1 or add DAEMON to DEFAULT_BUILD_FEATURES.',
      );
      process.exitCode = 1;
      return;
    }
    const kind = args[0] === '--daemon-worker' ? args[1] : args[0].split('=')[1];
    const { runDaemonWorker } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(kind);
    return;
  }

  // 【快速路径 6】remote-control 桥接模式（别名 rc / remote / sync / bridge）：
  // 把本机注册为远程可控环境。四道安全门的顺序是有讲究的：
  //   ① 先查 auth——没有 auth 时 GrowthBook 拿不到用户上下文，只会返回过期的默认 false
  //   ② GrowthBook 运行时门   ③ 最低版本检查   ④ 组织策略 allow_remote_control
  // 这是"快速路径也要做完整安全检查"的范例。
  if (
    feature('BRIDGE_MODE') &&
    (args[0] === 'remote-control' ||
      args[0] === 'rc' ||
      args[0] === 'remote' ||
      args[0] === 'sync' ||
      args[0] === 'bridge')
  ) {
    profileCheckpoint('cli_bridge_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();

    const { getBridgeDisabledReason, checkBridgeMinVersion } = await import('../bridge/bridgeEnabled.js');
    const { BRIDGE_LOGIN_ERROR } = await import('../bridge/types.js');
    const { bridgeMain } = await import('../bridge/bridgeMain.js');
    const { exitWithError } = await import('../utils/process.js');

    const { getClaudeAIOAuthTokens } = await import('../utils/auth.js');
    const { getBridgeAccessToken } = await import('../bridge/bridgeConfig.js');
    if (!getClaudeAIOAuthTokens()?.accessToken && !getBridgeAccessToken()) {
      exitWithError(BRIDGE_LOGIN_ERROR);
    }
    const disabledReason = await getBridgeDisabledReason();
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`);
    }
    const versionError = checkBridgeMinVersion();
    if (versionError) {
      exitWithError(versionError);
    }

    const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import('../services/policyLimits/index.js');
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError("Error: Remote Control is disabled by your organization's policy.");
    }

    await bridgeMain(args.slice(1));
    return;
  }

  // 【快速路径 7】daemon 子命令：统一命名空间下的守护进程 + 后台会话管理
  // （start/stop 是 supervisor 管理；bg/attach/logs/kill 是后台会话）。
  // 与 daemon-worker 相反：这是用户面向的命令，需要完整配置和埋点。
  if ((feature('DAEMON') || feature('BG_SESSIONS')) && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { setShellIfWindows } = await import('../utils/windowsPaths.js');
    setShellIfWindows();
    const { initSinks } = await import('../utils/sinks.js');
    initSinks();
    const { daemonMain } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // 【快速路径 8】autonomy：自治状态查询，纯文本输出。
  // 不走完整 CLI 的原因：Commander 路径的 root preAction 初始化会在
  // coverage/CI 下留下无关句柄，污染简单的状态子进程调用。所以 print 后强退。
  if (args[0] === 'autonomy') {
    profileCheckpoint('cli_autonomy_path');
    const { getAutonomyCommandText } = await import('../cli/handlers/autonomy.js');
    const text = await getAutonomyCommandText(args.slice(1).join(' '));
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    process.exit(0);
  }

  // 【快速路径 9】--bg / --background：后台会话快捷入口 → daemon bg。
  if (feature('BG_SESSIONS') && (args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_daemon_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { setShellIfWindows } = await import('../utils/windowsPaths.js');
    setShellIfWindows();
    const bg = await import('../cli/bg.js');
    await bg.handleBgStart(args.filter(a => a !== '--bg' && a !== '--background'));
    return;
  }

  // 【快速路径 10】ps / logs / attach / kill：旧命令向后兼容，
  // 打印 deprecation 提示后映射到 daemon 子命令（ps → daemon status）。
  if (
    feature('BG_SESSIONS') &&
    (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill')
  ) {
    const mapped = args[0] === 'ps' ? 'status' : args[0];
    console.error(`[deprecated] Use: claude daemon ${mapped}${args[1] ? ' ' + args[1] : ''}`);
    profileCheckpoint('cli_daemon_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { setShellIfWindows } = await import('../utils/windowsPaths.js');
    setShellIfWindows();
    const { initSinks } = await import('../utils/sinks.js');
    initSinks();
    const { daemonMain } = await import('../daemon/main.js');
    await daemonMain([args[0] === 'ps' ? 'status' : args[0]!, ...args.slice(1)]);
    return;
  }

  // 【快速路径 11】job 模板任务（new / list / reply 是旧命令的兼容映射）。
  // 注意这里用 process.exit 而不是 return：模板任务的 Ink TUI 会留下
  // 事件循环句柄阻止自然退出。return 和 process.exit 的选择取决于
  // 有没有残留句柄，不是随手写的。
  if (feature('TEMPLATES') && args[0] === 'job') {
    profileCheckpoint('cli_templates_path');
    const { templatesMain } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args.slice(1));
    process.exit(0);
  }
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    console.error(`[deprecated] Use: claude job ${args[0]} ${args.slice(1).join(' ')}`.trim());
    profileCheckpoint('cli_templates_path');
    const { templatesMain } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    process.exit(0);
  }

  // 【快速路径 12】--tmux + --worktree：在加载完整 CLI 之前 exec 进 tmux worktree
  // （换运行环境要趁早，晚了就得重启整个 CLI）。未处理/出错则落回正常路径。
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (
    hasTmuxFlag &&
    (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))
  ) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { isWorktreeModeEnabled } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const { execIntoTmuxWorktree } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      if (result.error) {
        const { exitWithError } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // 【修正 1】--update / --upgrade 不是子命令，直接改写 argv 重定向到 update
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // 【修正 2】--bare 要在模块求值期就设置 SIMPLE：
  // 否则精简门在 Commander 构建选项的阶段就已经错过了（晚了只能管到 action handler）。
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // 【主线】全部快速路径未命中：加载完整 CLI。
  // ① 开启早期输入捕获（用户在模块加载期间敲的内容不丢）
  // ② 动态 import main.jsx —— 此刻 React/Ink/全部 149 个组件才进入内存
  // ③ cliMain() 跑 Commander 注册表，进入 REPL
  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();
  profileCheckpoint('cli_before_main_import');
  const { main: cliMain } = await import('../main.jsx');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

await main();
