// Local mail sink for development: prints every email and keeps the latest per recipient in .dev-mail/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';

const port = Number(process.env.SMTP_PORT ?? 1025);
mkdirSync('.dev-mail', { recursive: true });

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onData(stream, session, done) {
    let data = '';
    stream.on('data', (chunk) => (data += chunk));
    stream.on('end', () => {
      const body = data.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      const to = session.envelope.rcptTo[0]?.address ?? 'unknown';
      writeFileSync(`.dev-mail/${to}.txt`, body);
      console.log(`mail to ${to}\n${body}\n`);
      done();
    });
  },
});
server.listen(port, '127.0.0.1', () => console.log(`dev mail sink on :${port}`));
