/**
 * browser.js — 浏览器生命周期管理（内部模块，不对外暴露）
 *
 * 设计思路：
 *   Skill 内部自己管理浏览器进程，对外只暴露 ensureBrowser()。
 *   调用方不需要关心 launch/connect/端口/CDP 等细节。
 *   支持 Chrome / Edge / Chromium 等所有基于 Chromium 的浏览器。
 *
 * 流程：
 *   1. 先检查指定端口是否已有浏览器在跑 → 有就 connect
 *   2. 没有 → 自动检测或使用配置的浏览器路径启动
 *   3. 找到 / 新开 Gemini 标签页
 *   4. 返回 { browser, page }
 */
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { platform, homedir } from 'node:os';
import { join, basename } from 'node:path';
import config from './config.js';

// ── 用 puppeteer-extra 包装 puppeteer-core，注入 stealth 插件 ──
const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ── 模块级单例：跨调用复用同一个浏览器 ──
let _browser = null;

// ── 各平台浏览器候选路径（Chrome、Edge、Chromium）──
const BROWSER_CANDIDATES = {
  win32: [
    // Chrome
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // Edge
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Chromium
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

/**
 * 自动检测系统上可用的 Chromium 系浏览器
 * @returns {string | undefined} 找到的浏览器可执行文件路径
 */
function detectBrowser() {
  // 还可以检查用户通过环境变量传入的常用别名
  const envPaths = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA,
  ];

  const os = platform();
  const candidates = BROWSER_CANDIDATES[os] || [];

  // Windows 额外：从环境变量目录组合路径
  if (os === 'win32') {
    for (const base of envPaths) {
      if (!base) continue;
      candidates.push(
        `${base}\\Google\\Chrome\\Application\\chrome.exe`,
        `${base}\\Microsoft\\Edge\\Application\\msedge.exe`,
      );
    }
  }

  for (const p of candidates) {
    if (existsSync(p)) {
      console.log('[browser] auto-detected:', p);
      return p;
    }
  }

  return undefined;
}

// ── userDataDir：WJZ_P 全局浏览器数据目录 ──
// 所有伟大的 WJZ_P 项目共享同一个浏览器数据目录，保证 cookie / 登录态跨项目统一。
// 不使用浏览器默认数据目录的原因：
//   - macOS 下 Chrome 不能用默认路径开启 debug 模式（数据目录被锁）
//   - 独立目录保证与日常浏览器完全隔离，反爬更安全
const GLOBAL_WJZ_DATA_DIR = join(homedir(), '.wjz_browser_data');

/**
 * 获取浏览器默认 userDataDir 路径（作为克隆源）
 *
 * 按优先级尝试 Chrome > Edge > Chromium，返回第一个存在的路径。
 *
 * @returns {string | undefined}
 */
function getDefaultBrowserDataDir() {
  const os = platform();
  const home = homedir();

  const candidates = [];

  if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    candidates.push(
      join(localAppData, 'Google', 'Chrome', 'User Data'),
      join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      join(localAppData, 'Chromium', 'User Data'),
    );
  } else if (os === 'darwin') {
    const lib = join(home, 'Library', 'Application Support');
    candidates.push(
      join(lib, 'Google', 'Chrome'),
      join(lib, 'Microsoft Edge'),
      join(lib, 'Chromium'),
    );
  } else {
    // Linux
    candidates.push(
      join(home, '.config', 'google-chrome'),
      join(home, '.config', 'microsoft-edge'),
      join(home, '.config', 'chromium'),
    );
  }

  for (const dir of candidates) {
    if (existsSync(dir)) {
      console.log('[browser] found default browser data dir:', dir);
      return dir;
    }
  }

  return undefined;
}

/**
 * 从浏览器默认数据目录克隆关键资产到 WJZ 数据目录
 *
 * 只拷贝 cookie、登录态、偏好设置等"资产"，跳过锁文件和缓存，
 * 确保克隆后的目录能正常启动且不与原浏览器实例冲突。
 *
 * 跳过的文件 / 目录（basename 匹配）：
 *   - SingletonLock / SingletonSocket / SingletonCookie — 进程锁，拷贝会导致无法启动
 *   - lockfile — 锁文件
 *   - Cache / Code Cache / GPUCache / DawnCache / GrShaderCache — 缓存目录，体积大且不必要
 *   - CrashpadMetrics-active.pma — 崩溃指标活跃文件
 *   - BrowserMetrics / BrowserMetrics-spare.pma — 浏览器指标文件
 *
 * @param {string} sourceDir - 浏览器默认数据目录
 * @param {string} targetDir - WJZ 数据目录
 */
function cloneProfileFromDefault(sourceDir, targetDir) {
  console.log(`[browser] 首次运行，正在从浏览器默认数据克隆资产...`);
  console.log(`[browser]   源：${sourceDir}`);
  console.log(`[browser]   目标：${targetDir}`);

  /** 需要跳过的文件 / 目录名（全部小写比较） */
  const SKIP_NAMES = new Set([
    // 进程锁
    'singletonlock',
    'singletonsocket',
    'singletoncookie',
    'lockfile',
    // 缓存（体积大，浏览器会自动重建）
    'cache',
    'code cache',
    'gpucache',
    'dawncache',
    'grshadercache',
    // 崩溃 / 指标
    'crashpadmetrics-active.pma',
    'browsermetrics',
    'browsermetrics-spare.pma',
  ]);

  /**
   * cpSync 的 filter 回调：返回 true 表示拷贝，false 表示跳过
   * @param {string} src
   * @param {string} _dest
   * @returns {boolean}
   */
  const filterFunc = (src, _dest) => {
    const name = basename(src).toLowerCase();
    if (SKIP_NAMES.has(name)) {
      return false;
    }
    return true;
  };

  try {
    cpSync(sourceDir, targetDir, { recursive: true, filter: filterFunc });
    console.log(`[browser] 克隆完成`);
  } catch (err) {
    // 克隆失败不致命：目录已创建，浏览器会以全新状态启动（需手动登录）
    console.warn(`[browser] ⚠ 克隆过程中出现错误（浏览器仍可启动，但需要重新登录）:`, err.message);
  }
}

/**
 * 解析 userDataDir
 *
 * 优先级：
 *   1. 环境变量 BROWSER_USER_DATA_DIR（config 已处理）
 *   2. WJZ_P 全局目录 ~/.wjz_browser_data
 *      - 目录已存在 → 直接使用
 *      - 目录不存在（首次运行）→ 创建并从浏览器默认数据目录克隆关键资产
 *
 * @returns {string}
 */
function resolveUserDataDir() {
  // 1. 环境变量（已由 config 读取）
  if (config.browserUserDataDir) {
    return config.browserUserDataDir;
  }

  // 2. WJZ_P 全局目录
  if (existsSync(GLOBAL_WJZ_DATA_DIR)) {
    console.log(`[browser] using WJZ data dir: ${GLOBAL_WJZ_DATA_DIR}`);
    return GLOBAL_WJZ_DATA_DIR;
  }

  // 首次运行：创建目录并尝试从浏览器默认数据克隆
  console.log(`[browser] WJZ data dir not found, initializing: ${GLOBAL_WJZ_DATA_DIR}`);
  mkdirSync(GLOBAL_WJZ_DATA_DIR, { recursive: true });

  const defaultDir = getDefaultBrowserDataDir();
  if (defaultDir) {
    cloneProfileFromDefault(defaultDir, GLOBAL_WJZ_DATA_DIR);
  } else {
    console.log('[browser] 未找到浏览器默认数据目录，将使用空白配置（首次启动需手动登录）');
  }

  return GLOBAL_WJZ_DATA_DIR;
}

/**
 * 探测指定端口是否有浏览器在监听
 * @param {number} port
 * @param {string} [host='127.0.0.1']
 * @param {number} [timeout=1500]
 * @returns {Promise<boolean>}
 */
function isPortAlive(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** 浏览器启动参数（适用于所有 Chromium 系浏览器） */
const BROWSER_ARGS = [
  // ── 基础 ──
  '--no-first-run',                          // 跳过首次运行的欢迎页 / 引导流程
  '--disable-default-apps',                  // 不安装 Chrome 默认应用（Gmail、Drive 等）
  '--disable-popup-blocking',                // 允许弹窗，避免 Gemini 功能被拦截

  // ── 渲染稳定性 ──
  '--disable-gpu',                           // 禁用 GPU 硬件加速，防止无显卡环境崩溃
  '--disable-software-rasterizer',           // 禁用软件光栅化后备，减少 CPU 开销
  '--disable-dev-shm-usage',                 // 不使用 /dev/shm（Docker 中该分区常太小导致崩溃）

  // ── sandbox：仅 Linux 无图形环境需要，Windows/macOS 桌面不加 ──
  // --no-sandbox / --disable-setuid-sandbox 在 Windows Edge 上会触发安全警告横幅
  ...(platform() === 'linux'
    ? [
        '--no-sandbox',                      // 关闭 Chromium 沙箱（Linux root 用户必须）
        '--disable-setuid-sandbox',          // 关闭 setuid 沙箱（配合 --no-sandbox）
      ]
    : []),

  // ── 反检测（配合 stealth 插件 + ignoreDefaultArgs） ──
  //'--disable-blink-features=AutomationControlled', // 移除 navigator.webdriver 标记，降低被检测为自动化的风险。stealth已经带上了，这里额外写会造成参数错误。

  // ── 网络 / 性能 ──
  '--disable-background-networking',         // 禁止后台网络请求（更新检查、遥测等）
  '--disable-background-timer-throttling',   // 后台标签页定时器不降频，保证轮询精度
  '--disable-backgrounding-occluded-windows',// 被遮挡的窗口不降级渲染
  '--disable-renderer-backgrounding',        // 渲染进程进入后台时不降优先级

  // ── UI 纯净度 ──
  '--disable-features=Translate',            // 禁用自动翻译弹窗
  '--no-default-browser-check',              // 不弹"设为默认浏览器"提示
  '--disable-crash-reporter',                // 禁用崩溃上报，减少后台进程
  '--hide-crash-restore-bubble',             // 隐藏"恢复上次会话"气泡
  '--test-type',  // 专门用来屏蔽“不受支持的命令行标记”的黄条警告
];

/**
 * 连接到已运行的浏览器
 * @param {number} port
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function connectBrowser(port) {
  const browserURL = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.connect({
    browserURL,
    defaultViewport: null,
    protocolTimeout: config.browserProtocolTimeout,
  });
  console.log('[browser] connected to existing browser on port', port);
  return browser;
}

/**
 * 启动新的浏览器实例
 * @param {object} opts
 * @param {string} opts.executablePath
 * @param {number} opts.port
 * @param {string} opts.userDataDir
 * @param {boolean} opts.headless
 * @param {object} [opts.debugOpts] - 调试/信号控制选项
 * @param {boolean} [opts.debugOpts.handleSIGINT=true]   - Puppeteer 是否在 SIGINT 时自动关闭浏览器
 * @param {boolean} [opts.debugOpts.handleSIGTERM=true]  - Puppeteer 是否在 SIGTERM 时自动关闭浏览器
 * @param {boolean} [opts.debugOpts.handleSIGHUP=true]   - Puppeteer 是否在 SIGHUP 时自动关闭浏览器
 * @returns {Promise<import('puppeteer-core').Browser>}
 */
async function launchBrowser({ executablePath, port, userDataDir, headless, debugOpts = {} }) {
  const {
    handleSIGINT = true,
    handleSIGTERM = true,
    handleSIGHUP = true,
  } = debugOpts;

  const browser = await puppeteer.launch({
    executablePath,
    headless,
    userDataDir,
    defaultViewport: null,
    args: [
      ...BROWSER_ARGS,
      `--remote-debugging-port=${port}`,
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    protocolTimeout: config.browserProtocolTimeout,
    handleSIGINT,
    handleSIGTERM,
    handleSIGHUP,
  });
  console.log('[browser] launched, pid:', browser.process()?.pid, 'port:', port, 'path:', executablePath);
  return browser;
}

/**
 * 在浏览器中找到 Gemini 标签页，或新开一个
 * @param {import('puppeteer-core').Browser} browser
 * @returns {Promise<import('puppeteer-core').Page>}
 */
async function findOrCreateGeminiPage(browser) {
  const pages = await browser.pages();

  // 优先复用已有的 Gemini 标签页
  for (const page of pages) {
    const url = page.url();
    if (url.includes('gemini.google.com')) {
      console.log('[browser] reusing existing Gemini tab:', url);
      await page.bringToFront();
      return page;
    }
  }

  // 没找到，新开一个
  const page = pages.length > 0 ? pages[0] : await browser.newPage();
  await page.goto('https://gemini.google.com/app', {
    waitUntil: 'networkidle2',
    timeout: 30_000,
  });
  console.log('[browser] opened new Gemini tab');
  return page;
}

/**
 * 确保浏览器可用 — Skill 唯一的对外浏览器管理入口
 *
 * 逻辑：
 *   1. 如果已有 _browser 且未断开 → 直接复用
 *   2. 检查端口是否有浏览器 → connect
 *   3. 否则自动检测 / 使用配置的路径启动浏览器
 *
 * userDataDir 解析优先级：
 *   opts.userDataDir > env BROWSER_USER_DATA_DIR > ~/.wjz_browser_data（首次自动从浏览器默认数据克隆）
 *
 * @param {object} [opts]
 * @param {string} [opts.executablePath] - 浏览器路径（不传则自动检测）
 * @param {number} [opts.port] - 调试端口（env: BROWSER_DEBUG_PORT，默认 40821）
 * @param {string} [opts.userDataDir] - 用户数据目录（env: BROWSER_USER_DATA_DIR，不传则多级兜底）
 * @param {boolean} [opts.headless] - 无头模式（env: BROWSER_HEADLESS，默认 false）
 * @param {object} [opts.debugOpts] - 调试/信号控制选项（透传给 Puppeteer launch）
 * @returns {Promise<{browser: import('puppeteer-core').Browser, page: import('puppeteer-core').Page}>}
 */
export async function ensureBrowser(opts = {}) {
  const {
    executablePath = config.browserPath,
    port = config.browserDebugPort,
    userDataDir = resolveUserDataDir(),
    headless = config.browserHeadless,
    debugOpts,
  } = opts;

  // 1. 复用已有连接
  if (_browser && _browser.isConnected()) {
    console.log('[browser] reusing existing connection');
    const page = await findOrCreateGeminiPage(_browser);
    return { browser: _browser, page };
  }

  // 2. 尝试连接已在运行的浏览器
  const alive = await isPortAlive(port);
  if (alive) {
    try {
      _browser = await connectBrowser(port);
      const page = await findOrCreateGeminiPage(_browser);
      return { browser: _browser, page };
    } catch (err) {
      console.warn('[browser] connect failed, will try launch:', err.message);
    }
  }

  // 3. 启动新浏览器：优先用配置路径，否则自动检测
  const resolvedPath = executablePath || detectBrowser();
  if (!resolvedPath) {
    throw new Error(
      `[browser] 端口 ${port} 无可用浏览器，且未找到可执行文件。\n` +
      `请通过以下任一方式解决：\n` +
      `  1. 设置环境变量 BROWSER_PATH 指向 Chrome / Edge / Chromium 的可执行文件\n` +
      `  2. 手动启动浏览器并开启调试端口：\n` +
      `     msedge --remote-debugging-port=${port}\n` +
      `     chrome --remote-debugging-port=${port}\n` +
      `  3. 安装 Chrome 或 Edge 到默认位置`
    );
  }

  try {
    _browser = await launchBrowser({ executablePath: resolvedPath, port, userDataDir, headless, debugOpts });
  } catch (err) {
    // 大概率是用户数据目录被正在运行的浏览器锁住了
    if (err.message?.includes('EPERM') || err.message?.includes('lock') || err.message?.includes('already')) {
      throw new Error(
        `报错信息：${err.message}\n`+
        `[browser] 无法启动浏览器，用户数据目录可能被占用：${userDataDir}\n` +
        `这通常是因为该浏览器正在运行且锁定了数据目录。\n\n` +
        `请选择以下任一方式解决：\n` +
        `  方式 1（推荐）：关闭正在运行的浏览器，让 skill 自动启动带调试端口的实例\n` +
        `  方式 2：保持浏览器运行，手动启用调试端口后重启浏览器：\n` +
        `          ${resolvedPath} --remote-debugging-port=${port}\n` +
        `  方式 3：设置 BROWSER_USER_DATA_DIR 为独立目录（将无法复用登录态）`
      );
    }
    throw err;
  }

  const page = await findOrCreateGeminiPage(_browser);
  return { browser: _browser, page };
}

/**
 * 断开浏览器连接（不杀进程，方便下次复用）
 *
 * 在 Windows 上，Node 退出时默认会终止所有子进程。
 * 因此 disconnect 前先对浏览器子进程做 unref + stdio detach，
 * 使浏览器进程脱离 Node 进程树，独立存活。
 */
export function disconnect() {
  if (_browser) {
    // 解除 Node 对浏览器子进程的引用，防止 Node 退出时杀掉它
    const proc = _browser.process();
    if (proc) {
      proc.unref();
      // 同时 unref 所有 stdio 流，避免 Node 因为管道未关闭而挂住
      if (proc.stdin)  proc.stdin.unref();
      if (proc.stdout) proc.stdout.unref();
      if (proc.stderr) proc.stderr.unref();
    }

    _browser.disconnect();
    _browser = null;
    console.log('[browser] disconnected (browser process kept alive)');
  }
}

/**
 * 关闭浏览器（杀进程）
 */
export async function close() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    console.log('[browser] closed');
  }
}
