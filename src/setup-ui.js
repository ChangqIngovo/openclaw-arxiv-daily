import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export function question(label, fallback = '', {hidden = false, input = process.stdin, output = process.stdout} = {}) {
  if (!input.isTTY) throw new Error('Run this setup in an interactive terminal.');
  return new Promise((resolve, reject) => {
    let muted = false, answered = false;
    const sink = new Writable({write(chunk, encoding, callback) { if (!muted) output.write(chunk,encoding); callback(); }});
    sink.isTTY = output.isTTY; sink.columns = output.columns || 80;
    const rl = createInterface({input,output:sink,terminal:true,historySize:hidden ? 0 : 30});
    const done = value => { answered = true; rl.close(); if (hidden) output.write('\n'); resolve(value.trim() || fallback); };
    rl.once('SIGINT', () => { answered = true; rl.close(); reject(new Error('Setup cancelled.')); });
    rl.once('close', () => { if (!answered) reject(new Error('Setup input closed.')); });
    if (hidden) { output.write(label + ': '); muted = true; rl.question('',done); }
    else rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `,done);
  });
}

export async function choose(label, choices, fallback = 0, ask = question) {
  if (!choices.length) throw new Error('No choices available.');
  console.log('\n' + label);
  choices.forEach((choice, index) => console.log(`  ${index+1}. ${typeof choice === 'string' ? choice : choice.label}`));
  for (;;) {
    const value = await ask('Number',String(fallback+1));
    if (/^[1-9]\d*$/.test(value) && Number(value) <= choices.length) return choices[Number(value)-1];
    console.log('Please enter a number from the list.');
  }
}
