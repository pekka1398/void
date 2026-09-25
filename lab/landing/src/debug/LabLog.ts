/**
 * Dev-only event log: lines are batched and POSTed to the Vite dev server,
 * which appends them to lab-log/<stream>.jsonl (see vite.config.ts), so a
 * session played in the browser can be read back afterwards.
 */
export class LabLog {
  private readonly pending: string[] = [];
  private failed = false;

  constructor(private readonly stream: string, private readonly onFatal: (error: Error) => void, flushMilliseconds = 500) {
    if (!/^[a-z0-9-]+$/.test(stream)) throw new Error(`LabLog: invalid stream name ${JSON.stringify(stream)}`);
    setInterval(() => this.flush(), flushMilliseconds);
    window.addEventListener('pagehide', () => this.flush());
  }

  write(event: Record<string, unknown>): void {
    this.pending.push(JSON.stringify({ wall: new Date().toISOString(), ...event }));
  }

  private flush(): void {
    if (this.failed || this.pending.length === 0) return;
    const body = this.pending.splice(0).join('\n') + '\n';
    void fetch(`/__lab-log/${this.stream}`, { method: 'POST', body, keepalive: true }).then((response) => {
      if (!response.ok) throw new Error(`LabLog: server answered ${response.status} for ${this.stream}`);
    }).catch((e: unknown) => {
      this.failed = true;
      this.onFatal(e instanceof Error ? e : new Error(String(e)));
    });
  }
}
