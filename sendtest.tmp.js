const fs=require('fs');
fs.readFileSync('.env.local','utf8').split(/\r?\n/).forEach(l=>{const m=l.match(/^([A-Z_]+)="?([^"]*)"?$/); if(m) process.env[m[1]]=m[2];});
const engine=require('./api/_engine');
const sent=require('./api/_sent');
const MailComposer=require('nodemailer/lib/mail-composer');
(async()=>{
  const conn=await engine.getConnection();
  const creds=engine.smtpCredentials(conn);
  const saver=sent.createSentSaver(conn,creds,(m)=>console.log('  warn:',m));
  console.log('saver enabled:', saver.enabled);

  const raw=await new MailComposer({
    from: conn.email, to: conn.email,
    subject: 'Kech verification — safe to delete',
    text: 'Written by Kech to verify Sent-folder saving. This copy is removed automatically.',
    attachments:[{filename:'probe.txt', content:Buffer.from('attachment round-trip check')}]
  }).compile().build();

  const problem=await saver.save(raw);
  console.log('append result:', problem===null ? 'SUCCESS' : 'FAILED -> '+problem);
  console.log('target folder:', saver.mailbox);
  await saver.close();

  // Verify it landed, then remove it so nothing of mine is left behind.
  const {ImapFlow}=require('imapflow');
  const c=new ImapFlow({host:conn.imap.host,port:conn.imap.port,secure:true,auth:{user:conn.imap.user||conn.email,pass:creds.pass},logger:false});
  await c.connect();
  const lock=await c.getMailboxLock(saver.mailbox||'INBOX.Sent');
  try{
    const hits=await c.search({subject:'Kech verification'});
    console.log('found in Sent  :', hits.length, 'message(s)');
    for(const m of await c.fetch({seq:hits.join(',')},{envelope:true,bodyStructure:true})){
      const parts=[]; (function walk(n){ if(!n) return; if(n.dispositionParameters&&n.dispositionParameters.filename) parts.push(n.dispositionParameters.filename); (n.childNodes||[]).forEach(walk); })(m.bodyStructure);
      console.log('   subject    :', m.envelope.subject);
      console.log('   attachments:', parts.length?parts.join(','):'none');
    }
    if(hits.length){ await c.messageDelete({seq:hits.join(',')}); console.log('cleanup        : test message deleted'); }
  } finally { lock.release(); }
  await c.logout();
})().catch(e=>console.log('ERROR:', e.message));
