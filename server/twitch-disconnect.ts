export type TwitchDisconnectOptions = {
  stop: () => void;
  clear: () => void;
  revoke: (() => Promise<void>) | null;
  publish: (message: string) => void;
  disconnectedMessage: string;
  revocationFailureMessage: string;
};

/** Stop local chat immediately, then report whether Twitch confirmed token revocation. */
export async function disconnectTwitch(options: TwitchDisconnectOptions): Promise<string> {
  options.stop();
  options.clear();
  if (!options.revoke) {
    options.publish(options.disconnectedMessage);
    return options.disconnectedMessage;
  }

  options.publish('Twitch chat stopped. Confirming token revocation.');
  let message = options.disconnectedMessage;
  try { await options.revoke(); }
  catch { message = options.revocationFailureMessage; }
  options.publish(message);
  return message;
}
