#!/usr/bin/env node
'use strict';
// Personal installer for Windows and macOS; OpenClaw 2026.9.6.
// Native login/consent flows remain interactive. No eval, policy bypass or test messages.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const PAYLOAD = __ARXIV_PAYLOAD__;
const VERSION = '0.5.1', HOST_VERSION = '2026.9.6', WEIXIN_VERSION = '2.4.8';
const args = process.argv.slice(2);
const fail = message => { throw new Error(message); };
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at+1]; };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stateDir = path.resolve(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(),'.openclaw'));
let target = path.resolve(option('--dir') || path.join(stateDir,'local-plugins',`arxiv-daily-${VERSION}`));
const stamp = new Date().toISOString().replace(/[:.]/g,'-');
let stoppedGateway = false, gatewayStartAttempted = false;

function runNode(file, cmdArgs, opts = {}) {
  const result = spawnSync(process.execPath,[file,...cmdArgs],{
    encoding:'utf8', stdio:opts.capture ? ['inherit','pipe','pipe'] : 'inherit',
    cwd:opts.cwd || process.cwd(), windowsHide:false, maxBuffer:8_000_000,...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !opts.allowFailure) {
    // Captured commands here only inspect public metadata, never credentials.
    if (opts.capture && result.stderr) process.stderr.write(result.stderr);
    fail(`Command failed (${result.status}): ${path.basename(file)} ${cmdArgs.slice(0,3).join(' ')}. Read the output above.`);
  }
  return result;
}
function jsonOutput(result) {
  if (result.status !== 0) return undefined;
  const output = result.stdout.trim();
  try { return JSON.parse(output); } catch {}
  // Banner may contain '['; try complete JSON documents starting at each line.
  for (const match of output.matchAll(/^[ \t]*([\[{])/gm)) {
    try { return JSON.parse(output.slice(match.index).trim()); } catch {}
  }
  fail('OpenClaw did not return parseable JSON. No configuration was guessed.');
}
function checkUpgrade(directory) {
  const pkg = JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory,'openclaw.plugin.json'),'utf8'));
  const previous = JSON.parse(Buffer.from(PAYLOAD.find(p => p.name === 'upgrade-manifests.json').data,'base64').toString('utf8'));
  const next = JSON.parse(Buffer.from(PAYLOAD.find(p => p.name === 'package.json').data,'base64').toString('utf8'));
  const known = pkg.name === 'openclaw-arxiv-daily' || pkg.version === '0.1.0' && pkg.name === 'arxiv-daily-local';
  if (!known || manifest.id !== 'arxiv-daily' || !previous[pkg.version] && pkg.version !== next.version) fail('Only a supported arxiv-daily installation can be upgraded automatically. No files changed.');
  for (const item of PAYLOAD) {
    const file = path.join(directory,item.name);
    if (!fs.existsSync(file)) continue;
    const hash = sha(fs.readFileSync(file));
    if (hash !== item.sha256 && !Object.values(previous).some(files => files[item.name] === hash)) fail(`Locally modified plugin file: ${file}\nPreserve and review your changes before upgrading. No files changed.`);
  }
}
function extract(replace = false) {
  for (const item of PAYLOAD) {
    if (path.isAbsolute(item.name) || item.name.split(/[\\/]/).includes('..')) fail('Invalid embedded path.');
    const bytes = Buffer.from(item.data,'base64');
    if (sha(bytes) !== item.sha256) fail(`Embedded checksum mismatch: ${item.name}`);
    const file = path.join(target,item.name);
    if (!replace && fs.existsSync(file) && sha(fs.readFileSync(file)) !== item.sha256) fail(`Existing file differs: ${file}. Rerun without --dir to upgrade the registered plugin.`);
  }
  for (const item of PAYLOAD) {
    const file = path.join(target,item.name);
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    if (replace || !fs.existsSync(file)) fs.writeFileSync(file,Buffer.from(item.data,'base64'),{mode:0o600});
  }
  console.log(`Source and instructions: ${target}`);
}
function samePath(a,b,platform = process.platform) {
  const normalize = value => platform === 'win32' ? value.toLowerCase() : value;
  return normalize(fs.realpathSync(a)) === normalize(fs.realpathSync(b));
}
function findNodeEntry(name, relative, {env = process.env, execPath = process.execPath, platform = process.platform, localState = stateDir} = {}) {
  const candidates = [];
  if (name === 'openclaw' && env.ARXIV_OPENCLAW_ENTRY) candidates.push(path.resolve(env.ARXIV_OPENCLAW_ENTRY));
  for (const dir of [...(env.PATH || env.Path || '').split(path.delimiter),path.dirname(execPath)]) {
    if (!dir) continue;
    const entries = platform === 'win32' ? [name,`${name}.cmd`,`${name}.exe`] : [name];
    for (const entry of entries) {
      const candidate = path.join(dir,entry);
      try { if (fs.lstatSync(candidate).isSymbolicLink()) candidates.push(fs.realpathSync(candidate)); } catch {}
    }
    candidates.push(path.join(dir,'node_modules',name,relative),path.join(dir,'..','lib','node_modules',name,relative));
  }
  if (env.APPDATA) candidates.push(path.join(env.APPDATA,'npm','node_modules',name,relative));
  candidates.push(path.join(localState,'arxiv-runtime','node_modules',name,relative));
  return candidates.find(file => fs.existsSync(file) && path.basename(file) === path.basename(relative) && fs.statSync(file).isFile());
}
function findOpenClaw() {
  const entry = findNodeEntry('openclaw','openclaw.mjs');
  if (!entry) return null;
  const root = path.dirname(entry), pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if (pkg.version !== HOST_VERSION) fail(`This version supports OpenClaw ${HOST_VERSION}; found ${pkg.version}. The installer will not replace your existing host. See README.md.`);
  return {entry,root};
}
function readWeixinAccounts(directory = stateDir) {
  const base = path.join(directory,'openclaw-weixin'), index = path.join(base,'accounts.json');
  if (!fs.existsSync(index)) return [];
  const ids = JSON.parse(fs.readFileSync(index,'utf8'));
  if (!Array.isArray(ids)) fail('Invalid Weixin account index.');
  const result = [];
  for (const id of new Set(ids)) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) continue;
    const raw = id.endsWith('-im-bot') ? id.slice(0,-7)+'@im.bot' : null;
    const file = [path.join(base,'accounts',`${id}.json`),...(raw ? [path.join(base,'accounts',`${raw}.json`)] : [])].find(file => fs.existsSync(file));
    if (!file) continue;
    const data = JSON.parse(fs.readFileSync(file,'utf8'));
    if (typeof data.token === 'string' && data.token.trim() && typeof data.userId === 'string' && /^[^\s\x00-\x1f]{1,240}@im\.wechat$/u.test(data.userId)) result.push({id,peer:data.userId,label:id});
  }
  // Never return token/baseUrl/other credential fields or print the raw documents.
  return result;
}
function backupConfig() {
  const config = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir,'openclaw.json');
  if (!fs.existsSync(config)) fail(`Config not found: ${config}`);
  const folder = path.join(stateDir,'arxiv-daily-backups',stamp);
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  fs.copyFileSync(config,path.join(folder,'openclaw.json'));
  console.log(`Config backup: ${folder}`);
  return folder;
}
function patch(claw, folder, config) {
  const file = path.join(folder,'arxiv-daily.patch.json');
  fs.writeFileSync(file,JSON.stringify({plugins:{entries:{'arxiv-daily':{config,llm:{allowAgentIdOverride:true}}}}},null,2),{mode:0o600});
  claw(['config','patch','--file',file,'--dry-run']); claw(['config','patch','--file',file]);
}
function installDependencies(host,npm) {
  console.log('Installing pinned parsers and running behavior tests.');
  runNode(npm,['ci','--ignore-scripts','--omit=dev','--omit=peer','--no-audit','--no-fund'],{cwd:target});
  const link = path.join(target,'node_modules','openclaw');
  if (fs.existsSync(link)) { if (!samePath(link,host.root)) fail(`Unexpected SDK path: ${link}`); }
  else fs.symlinkSync(host.root,link,process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of fs.readdirSync(path.join(target,'test')).filter(n => n.endsWith('.test.js')).sort()) runNode(path.join(target,'test',name),[],{cwd:target});
}
function startGateway(claw) {
  gatewayStartAttempted = true;
  console.log('Starting Gateway. Readiness can take a few minutes.');
  claw(['gateway','start']); stoppedGateway = false;
}
async function main() {
  const accepted = new Set(['--prepare-only','--dir','--account','--agent','--upgrade','--configure-zotero','--configure-model','--status','--help']);
  for (let i = 0; i < args.length; i++) {
    if (!accepted.has(args[i])) fail(`Unknown option: ${args[i]}. Personal edition uses one account; run --help.`);
    if (['--dir','--account','--agent'].includes(args[i])) { if (!args[i+1] || args[i+1].startsWith('--')) fail(`Missing value: ${args[i]}`); i++; }
  }
  if (args.filter(arg => arg === '--account').length > 1) fail('Personal edition uses one --account. Each person installs their own copy.');
  const actions = ['--prepare-only','--configure-zotero','--configure-model','--status'].filter(arg => args.includes(arg));
  if (actions.length > 1 || actions.length && args.includes('--upgrade')) fail('Choose one setup action at a time.');
  if (actions.length && (option('--account') || option('--agent') || option('--dir') && !args.includes('--prepare-only'))) fail('Account/agent selection belongs to the install wizard, not this action.');
  if (args.includes('--help')) {
    console.log(`Personal arXiv Daily ${VERSION}\nnode install-arxiv-daily.cjs                 # guided install or upgrade\nnode install-arxiv-daily.cjs --upgrade       # convert/update existing installation\nnode install-arxiv-daily.cjs --configure-model\nnode install-arxiv-daily.cjs --configure-zotero\nnode install-arxiv-daily.cjs --status\nnode install-arxiv-daily.cjs --prepare-only [--dir PATH]\nOptional: --account BOT_ACCOUNT_ID --agent AGENT_ID`); return;
  }
  const [major,minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || major === 24 && minor < 16 || major === 26 && minor < 1) fail('Install Node.js 24.16+ LTS (recommended) or 26.1+ from https://nodejs.org/en/download, reopen your terminal, then rerun.');
  if (args.includes('--prepare-only')) { extract(); console.log('Prepared only. OpenClaw was not changed.'); return; }
  if (!['win32','darwin'].includes(process.platform)) fail('Guided installation supports Windows and macOS. Use --prepare-only to inspect on another OS.');
  if (!process.stdin.isTTY) fail('Run node install-arxiv-daily.cjs in an interactive terminal.');
  let host = findOpenClaw();
  const npm = findNodeEntry('npm',path.join('bin','npm-cli.js'));
  if (!host) {
    if (actions.length || args.includes('--upgrade')) fail('No OpenClaw found. Run this installer without options for first setup.');
    if (!npm) fail('npm was not found. Install Node.js with npm and reopen your terminal.');
    const runtime = path.join(stateDir,'arxiv-runtime');
    console.log(`Installing OpenClaw ${HOST_VERSION} for this user: ${runtime}`);
    const npmVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(npm),'..','package.json'),'utf8')).version.split('.').map(Number);
    const permit = npmVersion[0] >= 12 || npmVersion[0] === 11 && npmVersion[1] >= 16 ? ['--allow-scripts=openclaw'] : [];
    runNode(npm,['install','--prefix',runtime,'--no-audit','--no-fund',...permit,`openclaw@${HOST_VERSION}`]);
    host = findOpenClaw(); if (!host) fail('OpenClaw installation did not create the expected entry.');
  }
  const claw = (cmd,opts = {}) => runNode(host.entry,cmd,opts);
  if (args.includes('--status')) { claw(['gateway','status']); claw(['channels','status','--channel','openclaw-weixin','--probe'],{allowFailure:true}); return; }
  const configFile = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir,'openclaw.json');
  if (!fs.existsSync(configFile)) {
    console.log('OpenClaw first-time setup: choose your own model login. No search provider is needed.');
    claw(['onboard','--agent-name','arxiv_bot_v1','--skip-channels','--skip-search','--skip-skills','--skip-ui','--install-daemon']);
  }
  claw(['config','validate']);
  const installed = jsonOutput(claw(['plugins','inspect','arxiv-daily','--json'],{capture:true,allowFailure:true}));
  const previousRoot = installed?.plugin?.rootDir;
  const current = jsonOutput(claw(['config','get','plugins.entries.arxiv-daily','--json'],{capture:true,allowFailure:true}));
  if (previousRoot) {
    if (option('--dir') && path.resolve(previousRoot) !== target) fail('Use the registered plugin directory when updating.');
    target = path.resolve(previousRoot);
  } else if (args.includes('--upgrade') || actions.length) fail('No arxiv-daily installation found. Run without options first.');
  const changingOnly = args.includes('--configure-model') || args.includes('--configure-zotero');
  if (changingOnly) {
    if (JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8')).version !== VERSION || !current?.config?.personal) fail('Upgrade to the personal edition first.');
    const config = {...current.config};
    const folder = backupConfig();
    if (args.includes('--configure-model')) {
      const {configureModel} = await import(pathToFileURL(path.join(target,'src','setup-model.js')).href);
      const changed = await configureModel({claw,jsonOutput,agentId:config.agentId});
      if (changed) { claw(['gateway','stop']); stoppedGateway = true; startGateway(claw); }
    } else {
      const {prepareZotero,commitZotero} = await import(pathToFileURL(path.join(target,'src','personal-setup.js')).href);
      const prepared = await prepareZotero({stateDir,config});
      // Check the non-secret patch before rotating any credential.
      patchDryRun(claw,folder,{...config,zotero:{enabled:true,credentialsFile:prepared.file}});
      claw(['gateway','stop']); stoppedGateway = true;
      config.zotero = commitZotero(prepared,stateDir,config);
      patch(claw,folder,config); startGateway(claw);
      console.log('Zotero connected. In Weixin: /arxiv save PAPER_ID (only papers you choose are saved).');
    }
    return;
  }
  if (!npm) fail('npm was not found. Reinstall Node.js with npm before updating.');
  if (previousRoot) checkUpgrade(target); else extract();
  // Before overwrite, use a temporary reviewed copy for the portable prompt only.
  const uiItem = PAYLOAD.find(item => item.name === 'src/setup-ui.js');
  const {question,choose} = await import(`data:text/javascript;base64,${uiItem.data}`);
  const folder = backupConfig();
  const weixin = jsonOutput(claw(['plugins','inspect','openclaw-weixin','--json'],{capture:true,allowFailure:true}));
  if (!weixin?.plugin) claw(['plugins','install',`@tencent-weixin/openclaw-weixin@${WEIXIN_VERSION}`]);
  else if ((weixin.plugin.packageVersion || weixin.plugin.version) !== WEIXIN_VERSION) fail(`This installer expects Weixin ${WEIXIN_VERSION}; the existing plugin was not replaced.`);
  claw(['plugins','enable','openclaw-weixin']);
  let accounts = readWeixinAccounts();
  if (!accounts.length) {
    console.log('Scan with your own Weixin account to receive your personal digest.');
    claw(['channels','login','--channel','openclaw-weixin']); accounts = readWeixinAccounts();
  }
  if (!accounts.length) fail('No logged-in Weixin account with a verified recipient. Complete channels login, then rerun.');
  let account;
  if (option('--account')) {
    account = accounts.find(row => row.id === option('--account'));
    if (!account) fail('The selected account is not logged in with a verified peer. Complete Weixin login first.');
  } else account = accounts.length === 1 ? accounts[0] : await choose('Choose your personal Weixin connection / 选择你自己的微信连接',accounts,Math.max(0,accounts.findIndex(row => current?.config?.allowedAccountIds?.length === 1 && row.id === current.config.allowedAccountIds[0])));
  const agents = jsonOutput(claw(['agents','list','--json'],{capture:true}));
  if (!Array.isArray(agents) || !agents.length) fail('No agent exists. Complete OpenClaw onboarding first.');
  let agent = agents.find(row => row.id === (option('--agent') || current?.config?.agentId || 'arxiv_bot_v1'));
  if (option('--agent') && !agent) fail('The requested agent does not exist.');
  if (!agent) agent = agents.length === 1 ? agents[0] : await choose('Choose the digest agent',agents.map(row => ({...row,label:row.id})),Math.max(0,agents.findIndex(row => row.isDefault)));
  const configured = {defaultTopics:['21cm','EoR','high redshift'],defaultLanguage:'zh',sendTime:'08:00',timeZone:'Asia/Shanghai',...current?.config,
    personal:true,allowedAccountIds:[account.id],ownerPeerId:account.peer,agentId:agent.id,maxSubscribers:1,lookbackDays:1};
  if (!previousRoot) {
    configured.defaultTopics = (await question('Topics in priority order / 关键词按优先级，用逗号分隔',configured.defaultTopics.join(', '))).split(/[,，]/).map(value => value.trim()).filter(Boolean);
  }
  console.log(`Personal connection: ${account.id}; agent: ${agent.id}; daily ${configured.sendTime} ${configured.timeZone}.`);
  console.log('Previous other subscriptions stay on disk but will not run or receive this personal digest.');
  if (!previousRoot) installDependencies(host,npm);
  console.log('Stopping Gateway while source and personal settings are updated.');
  claw(['gateway','stop']); stoppedGateway = true;
  if (previousRoot) {
    checkUpgrade(target);
    for (const item of PAYLOAD) {
      const file = path.join(target,item.name);
      if (fs.existsSync(file)) { const backup = path.join(folder,'plugin-source',item.name); fs.mkdirSync(path.dirname(backup),{recursive:true,mode:0o700}); fs.copyFileSync(file,backup); }
    }
    extract(true); installDependencies(host,npm);
  }
  if (!previousRoot) claw(['plugins','install','--link',target]);
  // Validate resolved owner and topics using the actual installed code.
  const {resolveConfig} = await import(pathToFileURL(path.join(target,'src','service.js')).href);
  const config = resolveConfig(configured);
  patch(claw,folder,config); claw(['plugins','enable','arxiv-daily']);
  claw(['agents','bind','--agent',agent.id,'--bind',`openclaw-weixin:${account.id}`]);
  const {initializeState,prepareZotero,commitZotero} = await import(pathToFileURL(path.join(target,'src','personal-setup.js')).href);
  initializeState(stateDir,config);
  const {configureModel} = await import(pathToFileURL(path.join(target,'src','setup-model.js')).href);
  await configureModel({claw,jsonOutput,agentId:agent.id});
  if (!config.zotero?.enabled && /^(y|yes)$/i.test(await question('Connect your personal Zotero now? (y/n)','n'))) {
    const prepared = await prepareZotero({stateDir,config});
    patchDryRun(claw,folder,{...config,zotero:{enabled:true,credentialsFile:prepared.file}});
    config.zotero = commitZotero(prepared,stateDir,config); patch(claw,folder,config);
  }
  claw(['config','validate']); claw(['gateway','install']); startGateway(claw);
  claw(['channels','status','--channel','openclaw-weixin','--probe'],{allowFailure:true});
  console.log('\nPersonal setup saved. In your Weixin conversation send /arxiv status, then /arxiv test.');
  console.log('The setup does not send test messages automatically. Check actual receipt on your phone.');
  console.log('Later: --configure-model changes the model; --configure-zotero connects your personal library.');
}
function patchDryRun(claw,folder,config) {
  const file = path.join(folder,'arxiv-daily-preflight.json');
  fs.writeFileSync(file,JSON.stringify({plugins:{entries:{'arxiv-daily':{config}}}}),{mode:0o600});
  claw(['config','patch','--file',file,'--dry-run']);
}
module.exports = {checkUpgrade,jsonOutput,findNodeEntry,readWeixinAccounts,samePath};
if (require.main === module) main().catch(error => {
  console.error(`\nSetup stopped: ${error.message}`);
  if (stoppedGateway && !gatewayStartAttempted) console.error('The Gateway is stopped. Resolve the error and rerun this installer; source/config updates were not bypassed.');
  if (gatewayStartAttempted) console.error('Gateway start was attempted; readiness was not confirmed. Run this installer with --status before reinstalling.');
  process.exitCode = 1;
});
