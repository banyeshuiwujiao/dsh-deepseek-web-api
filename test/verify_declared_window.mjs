// 验证「申报值真的以整数形式到达内核」：读运行时镜像里的 cordis.patch.yml，
// 把 deepseek-web-api 那段配置喂给**镜像里真正被客户端加载的** provider.js，看 resolveModel 返回什么。
// 纯本地，不碰 8787，不打上游。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MIRROR = "C:/Users/Admin/.dsh/profiles/desktop";
const yml = readFileSync(`${MIRROR}/cordis.patch.yml`, "utf8");

// 取 dsh-deepseek-web-api-provider 这一段（到下一个顶层 - insert 之前）
const start = yml.indexOf("id: dsh-deepseek-web-api-provider");
const rest = yml.slice(start);
const end = rest.indexOf("\n- insert:");
const block = end > 0 ? rest.slice(0, end) : rest;
const pick = (key) => {
  const m = block.match(new RegExp(`^\\s*${key}:\\s*(\\S+)`, "m"));
  return m ? m[1] : undefined;
};
const rawWindow = pick("maxContextWindow");
const rawTokens = pick("defaultMaxTokens");

const mod = await import(pathToFileURL(`${MIRROR}/node_modules/dsh-deepseek-web-api/lib/provider.js`).href);
const warns = [];
const adapter = new mod.DeepSeekWebApiAdapter(
  { autoStart: false, maxContextWindow: rawWindow, defaultMaxTokens: rawTokens },
  null,
  { warn: (m) => warns.push(String(m)), info: () => {}, debug: () => {}, error: () => {} },
);
const resolved = await adapter.resolveModel(mod.PROVIDER_ID, "deepseek-web-flash");

console.log(JSON.stringify({
  yamlRaw: { maxContextWindow: rawWindow, defaultMaxTokens: rawTokens },
  resolvedContextWindow: resolved.context?.contextWindow,
  type: typeof resolved.context?.contextWindow,
  isPositiveInteger: Number.isInteger(resolved.context?.contextWindow) && resolved.context.contextWindow > 0,
  defaultMaxTokens: resolved.defaultMaxTokens,
  inputModalities: resolved.inputModalities,
  coercionWarnings: warns,
}, null, 2));
await adapter.dispose?.();
process.exit(0);
