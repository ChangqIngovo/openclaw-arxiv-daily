#!/usr/bin/env node
'use strict';
// Windows installer for arxiv-daily 0.1.1, OpenClaw 2026.9.6.
// No shell eval, policy bypass, API-key copying, or outbound test messages.
// --prepare-only extracts the readable source without changing OpenClaw.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const PAYLOAD = __ARXIV_PAYLOAD__;

const args = process.argv.slice(2);
const fail = message => { throw new Error(message); };
const option = name => {const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const options = name => args.flatMap((arg, i) => arg === name ? [args[i + 1]] : []);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stateDir = path.resolve(process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw'));
const target = path.resolve(option('--dir') || path.join(stateDir, 'local-plugins', 'arxiv-daily-0.1.1'));
const prepareOnly = args.includes('--prepare-only');
const accountToAdd = option('--add-account');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let stoppedGateway = false;

function runNode(file, cmdArgs, options={}) {
  const result = spawnSync(process.execPath, [file, ...cmdArgs], {
    encoding: 'utf8', stdio: options.capture ? ['inherit','pipe','pipe'] : 'inherit',
    cwd: options.cwd || process.cwd(), windowsHide:false, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) fail(`Command failed (${result.status}): ${path.basename(file)} ${cmdArgs.slice(0,3).join(' ')}. Read the output above; no checks were bypassed.`);
  return result;
}

function extract() {
  // Check all paths and existing files before writing any file.
  for (const item of PAYLOAD) {
    if (path.isAbsolute(item.name) || item.name.split(/[\\/]/).includes('..')) fail('Invalid embedded path.');
    const bytes = Buffer.from(item.data, 'base64');
    if (sha(bytes) !== item.sha256) fail(`Embedded checksum mismatch: ${item.name}`);
    const destination = path.join(target, item.name);
    if (fs.existsSync(destination) && sha(fs.readFileSync(destination)) !== item.sha256) fail(`A locally modified file already exists: ${destination}\nPreserve your edits and choose another --dir before reinstalling.`);
  }
  for (const item of PAYLOAD) {
    const destination = path.join(target, item.name);
    fs.mkdirSync(path.dirname(destination), {recursive:true, mode:0o700});
    if (!fs.existsSync(destination)) fs.writeFileSync(destination, Buffer.from(item.data, 'base64'), {mode:0o600});
  }
  console.log(`Source, tests and Chinese instructions: ${target}`);
  console.log(`Read: ${path.join(target, 'README.md')}`);
}

function findOpenClaw() {
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA,'npm','node_modules','openclaw','openclaw.mjs'));
  candidates.push(path.join(path.dirname(process.execPath),'node_modules','openclaw','openclaw.mjs'));
  const where = spawnSync('where.exe',['openclaw'],{encoding:'utf8',windowsHide:true});
  if (where.status === 0) for (const p of where.stdout.trim().split(/\r?\n/)) candidates.push(path.join(path.dirname(p),'node_modules','openclaw','openclaw.mjs'));
  const entry = candidates.find(p=>fs.existsSync(p));
  if (!entry) fail('Cannot locate the npm-installed OpenClaw. The installer expects the standard Windows npm installation.');
  const root = path.dirname(entry);
  const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if (pkg.version !== '2026.9.6') fail(`This build targets OpenClaw 2026.9.6; found ${pkg.version}. No config changes made.`);
  return {entry, root};
}

function jsonOutput(result) {
  if (result.status !== 0) return undefined;
  const output = result.stdout.trim();
  try{return JSON.parse(output);}catch{}
  // Some CLI modes emit a banner before the JSON document.
  const start=output.indexOf('{'),end=output.lastIndexOf('}');
  if(start>=0&&end>start){try{return JSON.parse(output.slice(start,end+1));}catch{}}
  fail('OpenClaw did not return parseable JSON. No credentials or configuration will be guessed.');
}

function backupConfig() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir,'openclaw.json');
  if (!fs.existsSync(configPath)) fail(`Config not found at ${configPath}; refusing to create a second OpenClaw setup.`);
  const folder=path.join(stateDir,'arxiv-daily-backups',stamp);
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  fs.copyFileSync(configPath,path.join(folder,'openclaw.json'));
  console.log(`Config backup: ${folder}`);
  return folder;
}

function patch(claw, folder, config) {
  const patchFile=path.join(folder,'arxiv-daily.patch.json');
  fs.writeFileSync(patchFile,JSON.stringify({plugins:{entries:{'arxiv-daily':{
    config, llm:{allowAgentIdOverride:true},
  }}}},null,2),{mode:0o600});
  claw(['config','patch','--file',patchFile,'--dry-run']);
  claw(['config','patch','--file',patchFile]);
}

function main() {
  const accepted = new Set(['--prepare-only','--dir','--account','--agent','--add-account','--help']);
  for(let i=0;i<args.length;i++){
    if(!accepted.has(args[i]))fail(`Unknown option: ${args[i]}`);
    if(['--dir','--account','--agent','--add-account'].includes(args[i])) {if(!args[i+1]||args[i+1].startsWith('--'))fail(`Missing value: ${args[i]}`);i++;}
  }
  if(args.includes('--help')){
    console.log('node install-arxiv-daily.cjs --account BOT_ACCOUNT_ID [--account ANOTHER_BOT_ACCOUNT_ID] [--agent AGENT_ID]\nnode install-arxiv-daily.cjs --prepare-only [--dir PATH]\nnode install-arxiv-daily.cjs --add-account BOT_ACCOUNT_ID');return;
  }
  if(Number(process.versions.node.split('.')[0])<24)fail('Node 24 or newer is required.');
  if(!prepareOnly && process.platform!=='win32')fail('Installation targets Windows. Use --prepare-only to inspect the source on another OS.');
  if(prepareOnly&&accountToAdd)fail('--prepare-only and --add-account cannot be combined.');
  if(!accountToAdd)extract();
  if(prepareOnly){console.log('Prepared only. OpenClaw and the Gateway were not changed.');return;}

  const host=findOpenClaw();
  const claw=(cmd,options={})=>runNode(host.entry,cmd,options);
  const current=jsonOutput(claw(['config','get','plugins.entries.arxiv-daily','--json'],{capture:true,allowFailure:true}));
  const defaults={allowedAccountIds:[],agentId:'arxiv_bot_v1',
    defaultTopics:['21cm','EoR','high redshift'],defaultLanguage:'zh',sendTime:'08:00',timeZone:'Asia/Shanghai',maxSubscribers:50,lookbackDays:7};
  const configured={...defaults,...current?.config};
  if(!Array.isArray(configured.allowedAccountIds))fail('Existing allowedAccountIds is invalid; inspect it before continuing.');
  if(option('--agent'))configured.agentId=option('--agent');
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(configured.agentId))fail('Invalid agent ID.');
  configured.allowedAccountIds=[...new Set([...configured.allowedAccountIds,...options('--account')])];
  if(accountToAdd){
    if(!current?.config)fail('Install arxiv-daily first, then add an account.');
    configured.allowedAccountIds=[...new Set([...configured.allowedAccountIds,accountToAdd])];
  }
  if(!configured.allowedAccountIds.length)fail('Supply at least one --account BOT_ACCOUNT_ID from your Weixin login. Public builds do not contain personal account IDs.');
  if(configured.allowedAccountIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id)||/^(YOUR_|EXAMPLE_)/.test(id)))fail('Replace placeholders with the bot accountId printed by Weixin login, not a userId or URL.');
  if(configured.allowedAccountIds.length>60)fail('At most 60 allowed bot account IDs are supported.');
  if(!accountToAdd){
    const npmCandidates=[path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),
      ...(process.env.APPDATA?[path.join(process.env.APPDATA,'npm','node_modules','npm','bin','npm-cli.js')]:[])];
    const npm=npmCandidates.find(p=>fs.existsSync(p));
    if(!npm)fail('Cannot locate npm-cli.js next to Node. No configuration has been changed.');
    console.log('Installing pinned XML parser dependencies; lifecycle scripts are disabled.');
    runNode(npm,['ci','--ignore-scripts','--omit=dev','--omit=peer','--no-audit','--no-fund'],{cwd:target});
    // Resolve the public SDK against the already-installed host, without installing another host.
    const sdkLink=path.join(target,'node_modules','openclaw');
    if(fs.existsSync(sdkLink)){
      if(fs.realpathSync(sdkLink).toLowerCase()!==fs.realpathSync(host.root).toLowerCase())fail(`Unexpected SDK path at ${sdkLink}`);
    }else fs.symlinkSync(host.root,sdkLink,'junction');
    console.log('Running behavior tests before changing the Gateway.');
    runNode(path.join(target,'test','digest.test.js'),[],{cwd:target});
  }
  const backupFolder=backupConfig();
  let installed;
  if(!accountToAdd){
    installed=jsonOutput(claw(['plugins','inspect','arxiv-daily','--json'],{capture:true,allowFailure:true}));
    const previousRoot=installed?.plugin?.rootDir;
    if(previousRoot&&path.resolve(previousRoot).toLowerCase()!==target.toLowerCase())fail(`arxiv-daily already exists at ${previousRoot}. Keep the existing source or explicitly resolve the installation before rerunning.`);
  }
  console.log('Stopping the Gateway while the plugin/config changes are applied.');
  claw(['gateway','stop']);stoppedGateway=true;
  if(!accountToAdd&&!installed?.plugin){
    console.log('OpenClaw may ask you to review this local plugin and its capabilities.');
    claw(['plugins','install','--link',target]);
  }
  patch(claw,backupFolder,configured);
  // The native enable command enforces capability consent; no automatic bypass flags.
  claw(['plugins','enable','arxiv-daily']);
  const binds=['agents','bind','--agent',configured.agentId];
  for(const account of configured.allowedAccountIds)binds.push('--bind',`openclaw-weixin:${account}`);
  claw(binds);
  claw(['config','validate']);
  console.log('Starting Gateway. Startup may take a few minutes on this installation.');
  claw(['gateway','start']);stoppedGateway=false;
  claw(['plugins','inspect','arxiv-daily','--runtime','--json']);
  claw(['channels','status','--channel','openclaw-weixin','--probe'],{allowFailure:true});
  console.log('\nInstall/configuration commands finished. This does not yet prove actual Weixin receipt.');
  console.log('In EACH Weixin chat send:\n/arxiv subscribe 21cm, EoR, high redshift\n/arxiv test');
  console.log('Then check /arxiv status and actual phone delivery. Ordinary text should get no AI reply.');
  console.log(`Daily start: ${configured.sendTime} ${configured.timeZone}; scheduler is a plugin service, not an OpenClaw cron entry.`);
}

try{main();}catch(error){
  console.error(`\nInstallation stopped: ${error.message}`);
  if(stoppedGateway)console.error('The Gateway was stopped during setup. Resolve the reported error and rerun this installer; it was not silently restarted with an incomplete plugin.');
  process.exitCode=1;
}
