import nodemailer from 'nodemailer';
import type { AppConfig } from './config';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Interface mínima de envio de e-mail. Em produção usamos SMTP (nodemailer);
 * nos testes injetamos uma versão "falsa" que guarda as mensagens em memória.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function createSmtpMailer(smtp: AppConfig['smtp']): Mailer {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });

  return {
    async send(message) {
      await transport.sendMail({ from: smtp.from, ...message });
    },
  };
}

/** Mailer de teste: guarda tudo em `outbox`. */
export function createMemoryMailer(): Mailer & { outbox: MailMessage[] } {
  const outbox: MailMessage[] = [];
  return {
    outbox,
    async send(message) {
      outbox.push(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Templates (pt-BR)
// ---------------------------------------------------------------------------

export function verificationEmail(name: string, url: string): Omit<MailMessage, 'to'> {
  return {
    subject: 'Confirme seu e-mail - Megabot',
    text: `Olá, ${name}! Confirme seu e-mail acessando: ${url}`,
    html: `<p>Olá, ${name}!</p><p>Confirme seu e-mail clicando no link abaixo:</p><p><a href="${url}">Confirmar e-mail</a></p><p>Se você não criou uma conta, ignore esta mensagem.</p>`,
  };
}

export function resetPasswordEmail(name: string, url: string): Omit<MailMessage, 'to'> {
  return {
    subject: 'Redefinição de senha - Megabot',
    text: `Olá, ${name}! Para redefinir sua senha acesse: ${url}`,
    html: `<p>Olá, ${name}!</p><p>Recebemos um pedido para redefinir sua senha:</p><p><a href="${url}">Redefinir senha</a></p><p>Se não foi você, ignore esta mensagem.</p>`,
  };
}
