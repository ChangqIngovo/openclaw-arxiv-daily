import { choose, question } from './setup-ui.js';

// Provider IDs are entry points; model IDs always come from the host catalog.
export const PROVIDERS = [
  {id:'keep',label:'Keep the current model / 保留当前模型'},
  {id:'openai',label:'ChatGPT / OpenAI (choose sign-in or API key in OpenClaw)'},
  {id:'anthropic',label:'Claude / Anthropic API key',method:'api-key'},
  {id:'deepseek',label:'DeepSeek API key',method:'api-key'},
  {id:'google',label:'Gemini / Google AI Studio API key',method:'api-key'},
  {id:'other',label:'Other OpenClaw provider / 其他已支持的服务商'},
];
export function availableModels(document, provider) {
  if (!Array.isArray(document?.models)) throw new Error('OpenClaw returned no model catalog.');
  return [...new Map(document.models.filter(row => typeof row.key === 'string' && row.key.startsWith(`${provider}/`)
    && !/[\s\x00-\x1f]/.test(row.key) && row.available === true && String(row.input || '').includes('text'))
    .map(row => [row.key,{id:row.key,label:`${row.key}${row.contextWindow ? ` (${Math.round(row.contextWindow/1024)}k context)` : ''}`}])).values()];
}
export async function configureModel({claw, jsonOutput, agentId, ask = question, select = choose}) {
  const selected = await select('Model provider / 模型接入',PROVIDERS,0,ask);
  if (selected.id === 'keep') return null;
  const provider = selected.id === 'other' ? await ask('OpenClaw provider ID') : selected.id;
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(provider)) throw new Error('Invalid provider ID.');
  if (provider === 'deepseek') {
    const installed = jsonOutput(claw(['plugins','inspect','deepseek','--json'],{capture:true,allowFailure:true}));
    if (!installed?.plugin) claw(['plugins','install','@openclaw/deepseek-provider','--pin']);
    claw(['plugins','enable','deepseek']);
  }
  const login = await ask('Sign in / enter API key now? (y/n; n uses your existing login)','y');
  if (/^(y|yes)$/i.test(login)) {
    let method = selected.method;
    if (provider === 'openai') method = (await select('OpenAI sign-in / 登录方式',[
      {id:'oauth',label:'Sign in with ChatGPT / 浏览器登录'},
      {id:'api-key',label:'OpenAI API key / 使用 API 额度'},
      {id:'device-code',label:'ChatGPT device code / 设备码登录'},
    ],0,ask)).id;
    claw(['models','auth','login','--agent',agentId,'--provider',provider,...(method ? ['--method',method] : [])]);
  }
  else if (!/^(n|no)$/i.test(login)) throw new Error('Choose y or n.');
  const result = jsonOutput(claw(['models','list','--all','--refresh','--provider',provider,'--agent',agentId,'--json'],{capture:true}));
  const rows = availableModels(result,provider);
  if (!rows.length) throw new Error(`No usable text model for ${provider}. Complete provider login/model access in OpenClaw, then run --configure-model again. Your model was not changed by this selector.`);
  const model = await select('Choose a model / 选择具体模型',rows,0,ask);
  const agents = jsonOutput(claw(['config','get','agents.list','--json'],{capture:true}));
  const index = Array.isArray(agents) ? agents.findIndex(agent => agent.id === agentId) : -1;
  if (index < 0) throw new Error('Cannot locate the selected agent in config; no global model change was made.');
  const models = jsonOutput(claw(['config','get','agents.defaults.models','--json'],{capture:true,allowFailure:true})) || {};
  if (!Object.hasOwn(models,model.id)) {
    const entry = ['config','set',`agents.defaults.models[${JSON.stringify(model.id)}]`,'{}','--strict-json','--expect-current-absent'];
    claw([...entry,'--dry-run']); claw(entry);
  }
  // Set only this agent, preserving other agents and the user's provider logins.
  const args = ['config','set',`agents.list[${index}].model`,JSON.stringify({primary:model.id,fallbacks:[]}),'--strict-json'];
  claw([...args,'--dry-run']); claw(args);
  console.log(`日报模型 / Digest model: ${model.id}`);
  return model.id;
}
