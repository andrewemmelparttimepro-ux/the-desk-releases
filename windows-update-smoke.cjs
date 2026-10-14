const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
const asar = require('@electron/asar');
const executable = path.join(process.env.RUNNER_TEMP, 'DeskSmoke', 'The Desk.exe');
const expected = process.env.EXPECTED_VERSION;
fs.mkdirSync('evidence', { recursive: true });
const delay = ms => new Promise(r => setTimeout(r, ms));
let ownedApp;
const step = message => console.log(new Date().toISOString(), message);
setTimeout(()=>{console.error('Windows update smoke exceeded six minutes');process.exit(1)},360000).unref();
(async () => {
  // A disposable CI account and fake offline home; no customer connection is used.
  step('Launching installed baseline');
  let app = ownedApp = await _electron.launch({ executablePath: executable, timeout: 60000 });
  step('Baseline launched');
  const first = await app.firstWindow();
  await first.waitForFunction(() => !!window.desk);
  const start = await first.evaluate(() => window.desk.call('bootstrap'));
  step('Baseline version '+start.version);
  assert(!start.version.startsWith(expected), 'The test must upgrade from a different version.');
  await app.evaluate(({ app, safeStorage }) => {
    const fs = require('node:fs'), path = require('node:path');
    const state = { homes: [{id:'smoke', origin:'http://127.0.0.1:1', token:'test-only',label:'Update test',person:'Test member',role:'member',drafts:{room:{text:'Draft kept through update',files:[],clientId:'smoke-draft'}}}], selected:'smoke', preferences:{theme:'paper',notifications:false} };
    fs.writeFileSync(path.join(app.getPath('userData'), 'desk-access.enc'), safeStorage.encryptString(JSON.stringify(state)));
  });
  await app.close();
  step('Saved the fake member access and closed baseline');
  app = ownedApp = await _electron.launch({ executablePath: executable, timeout: 60000 });
  const oldPid = app.process().pid;
  const window = await app.firstWindow();
  await window.waitForFunction(() => !!window.desk);
  step('Checking for the update');
  await window.evaluate(() => window.desk.call('update', {install:false}));
  await window.getByRole('button',{name:'Download update',exact:true}).waitFor({timeout:90000});
  step('Update available');
  await window.screenshot({path:'evidence/update-available.png'});
  await window.getByRole('button',{name:'Download update',exact:true}).click();
  await window.getByRole('button',{name:'Restart and install',exact:true}).waitFor({timeout:180000});
  const ready = await window.evaluate(() => window.desk.call('bootstrap'));
  step('Download ready');
  assert.equal(ready.update.version, expected);
  assert.equal(ready.update.status, 'ready');
  await window.screenshot({path:'evidence/update-ready.png'});
  // Accept the app's restart confirmation, leaving the real updater/installer untouched.
  const saved = await app.evaluate(({app, dialog, safeStorage}, evidence) => {
    const fs=require('node:fs'),path=require('node:path');
    const filename=path.join(app.getPath('userData'),'desk-access.enc');
    dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});
    app.on('before-quit',()=>{fs.copyFileSync(filename,path.join(evidence,'access-before-install.enc'));});
    return {filename, state:JSON.parse(safeStorage.decryptString(fs.readFileSync(filename)))};
  }, path.resolve('evidence'));
  assert.equal(saved.state.homes[0].drafts.room.text, 'Draft kept through update');
  const closed = new Promise(resolve => app.process().once('exit', resolve));
  step('Restarting to install');
  await window.getByRole('button',{name:'Restart and install',exact:true}).click();
  await Promise.race([closed, delay(90000).then(()=>{throw Error('Old app did not exit');})]);
  let installed, newPid;
  for(let attempt=0; attempt<90; attempt++) {
    await delay(2000);
    try {
      installed=JSON.parse(asar.extractFile(path.join(path.dirname(executable),'resources','app.asar'),'package.json').toString());
      const processes=JSON.parse(cp.execFileSync('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${executable.replaceAll("'","''")}' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId | ConvertTo-Json -Compress`],{encoding:'utf8'}));
      const candidates=Array.isArray(processes)?processes:[processes];
      newPid=candidates.find(x=>x && x.ProcessId!==oldPid)?.ProcessId;
      if(installed.version===expected && newPid)break;
    }catch{}
  }
  assert.equal(installed?.version,expected,'The new version must be installed.');
  assert(newPid,'The installer must reopen The Desk.');
  assert(fs.existsSync(saved.filename),'Saved access must remain after updating.');
  // Windows protects safeStorage with this CI user's DPAPI. The updated app's fresh
  // process receives a second-instance notification; the data file remains owned here.
  const after=fs.readFileSync(saved.filename);
  assert(after.equals(fs.readFileSync('evidence/access-before-install.enc')), 'Installer must preserve the exact encrypted access and drafts saved before quitting.');
  fs.unlinkSync('evidence/access-before-install.enc');
  fs.writeFileSync('evidence/result.json',JSON.stringify({from:start.version,to:installed.version,downloadedVersion:ready.update.version,oldPid,newPid,installerRelaunched:true,savedAccessFileRetained:true,encryptedAccessAndDraftsUnchanged:true,draftSavedBeforeRestart:saved.state.homes[0].drafts.room.text,platform:process.platform},null,2));
  step('Installer reopened the new version');
  console.log('PASS', start.version, '->', installed.version, 'downloaded, installed, relaunched; access file retained.');
})().then(()=>process.exit(0)).catch(async e=>{console.error(e);try{await ownedApp?.close()}catch{}process.exit(1);});
