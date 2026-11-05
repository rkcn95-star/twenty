import nodemailer from 'nodemailer';
import type { Mail } from './auth.js';

export const createMailer = (smtpUrl: string, from: string) => {
  const transport = nodemailer.createTransport(smtpUrl);
  return async (mail: Mail): Promise<void> => {
    await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
  };
};
