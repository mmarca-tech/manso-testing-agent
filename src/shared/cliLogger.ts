export function createProgressLogger(prefix: string): (message: string) => void {
  const startedAt = Date.now();

  return (message: string): void => {
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`[${prefix} +${elapsedSeconds}s] ${message}`);
  };
}
