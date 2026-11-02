import { existsSync, mkdirSync, copyFileSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';

export function stateFilePath(env, localDataDirectory) {
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH;
  if ((env.RAILWAY_SERVICE_ID || env.RAILWAY_ENVIRONMENT_ID) && !volume) {
    throw new Error('Persistent storage is required on Railway. Attach a Volume to this bot service (recommended mount path /app/data), then deploy again. No temporary state file was created.');
  }
  return join(resolve(volume || localDataDirectory), 'state.json');
}

export function prepareStateStorage(env, localDataDirectory) {
  const target = stateFilePath(env, localDataDirectory);
  const source = join(resolve(localDataDirectory), 'state.json');
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (volume && !existsSync(resolve(volume))) {
    throw new Error('The Railway volume mount directory is missing. Check the Volume attachment before starting the bot.');
  }
  // Preserve any still-accessible legacy state when adopting a differently mounted volume.
  // Never replace existing volume state, and never delete the source file.
  if (volume && source !== target && existsSync(source) && !existsSync(target)) {
    mkdirSync(resolve(volume), { recursive: true });
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
  return target;
}
