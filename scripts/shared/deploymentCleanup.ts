import { unlinkSync } from 'node:fs';

type DeploymentCleanupEvent = 'exit' | 'SIGINT' | 'SIGTERM';

type DeploymentCleanupRuntime = {
  once: (event: DeploymentCleanupEvent, listener: () => void) => void;
  off: (event: DeploymentCleanupEvent, listener: () => void) => void;
  exit: (code: number) => void;
};

export function registerDeploymentCleanup(args: {
  releaseDeploymentRegistryLock: () => boolean;
  runtime?: DeploymentCleanupRuntime;
}): {
  setTempKeypairPath: (filePath: string) => void;
  cleanup: () => boolean;
} {
  const runtime =
    args.runtime ||
    ({
      once: (event, listener) => process.once(event, listener),
      off: (event, listener) => process.off(event, listener),
      exit: (code) => process.exit(code),
    } satisfies DeploymentCleanupRuntime);
  let tempKeypairPath: string | undefined;
  let complete = false;
  let terminating = false;

  const removeTempKeypair = (): boolean => {
    if (!tempKeypairPath) return true;
    try {
      unlinkSync(tempKeypairPath);
      tempKeypairPath = undefined;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        tempKeypairPath = undefined;
        return true;
      }
      try {
        console.warn(
          `⚠️  Failed to remove temporary deployer keypair ${tempKeypairPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        // Cleanup warnings must not disrupt the caller.
      }
      return false;
    }
  };

  const onExit = () => {
    cleanup();
  };
  const terminate = (exitCode: number) => {
    if (terminating) return;
    terminating = true;
    cleanup();
    runtime.exit(exitCode);
  };
  const onSigint = () => terminate(130);
  const onSigterm = () => terminate(143);
  const detach = () => {
    runtime.off('exit', onExit);
    runtime.off('SIGINT', onSigint);
    runtime.off('SIGTERM', onSigterm);
  };
  const cleanup = (): boolean => {
    if (complete) return true;
    const tempKeypairRemoved = removeTempKeypair();
    let lockReleased = false;
    try {
      lockReleased = args.releaseDeploymentRegistryLock();
    } catch (err) {
      try {
        console.warn(`⚠️  Failed to release deployment-registry lock: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // Cleanup warnings must not disrupt the caller.
      }
    }
    if (tempKeypairRemoved && lockReleased) {
      complete = true;
      detach();
    }
    return complete;
  };

  runtime.once('exit', onExit);
  runtime.once('SIGINT', onSigint);
  runtime.once('SIGTERM', onSigterm);

  return {
    setTempKeypairPath: (filePath) => {
      if (complete) {
        throw new Error('Cannot register a temporary deployer keypair after deployment cleanup completed');
      }
      tempKeypairPath = filePath;
    },
    cleanup,
  };
}
