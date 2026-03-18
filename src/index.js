/**
 * gemini-skill — 统一入口
 *
 * 对外只暴露高层 API，浏览器管理在内部自动完成。
 *
 * 用法：
 *   import { createGeminiSession, disconnect } from './index.js';
 *
 *   const { ops } = await createGeminiSession();
 *   await ops.generateImage('画一只猫');
 *   disconnect();
 */
import { ensureBrowser, disconnect, close } from './browser.js';
import { createOps } from './gemini-ops.js';

export { disconnect, close };

/**
 * 创建 Gemini 操控会话
 *
 * 内部自动管理浏览器连接：
 *   1. 端口有 Chrome → 直接 connect
 *   2. 无 Chrome + 提供了 executablePath → 自动 launch
 *   3. 无 Chrome + 无 executablePath → 报错并提示手动启动
 *
 * 所有参数均可通过环境变量配置（见 .env），opts 传参优先级更高。
 *
 * @param {object} [opts]
 * @param {string} [opts.executablePath] - 浏览器路径（env: BROWSER_PATH，不设则自动检测）
 * @param {number} [opts.port] - 调试端口（env: BROWSER_DEBUG_PORT，默认 40821）
 * @param {string} [opts.userDataDir] - 用户数据目录（env: BROWSER_USER_DATA_DIR）
 * @param {boolean} [opts.headless] - 无头模式（env: BROWSER_HEADLESS，默认 false）
 * @param {object} [opts.debugOpts] - 调试/信号控制选项（透传给 Puppeteer launch）
 * @param {boolean} [opts.debugOpts.handleSIGINT=true]   - Puppeteer 是否在 SIGINT 时自动关闭浏览器
 * @param {boolean} [opts.debugOpts.handleSIGTERM=true]  - Puppeteer 是否在 SIGTERM 时自动关闭浏览器
 * @param {boolean} [opts.debugOpts.handleSIGHUP=true]   - Puppeteer 是否在 SIGHUP 时自动关闭浏览器
 * @returns {Promise<{ops: ReturnType<typeof createOps>, page: import('puppeteer-core').Page, browser: import('puppeteer-core').Browser}>}
 */
export async function createGeminiSession(opts = {}) {
  const { browser, page } = await ensureBrowser(opts);
  const ops = createOps(page);
  return { ops, page, browser };
}
