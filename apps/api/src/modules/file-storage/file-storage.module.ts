import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { FILE_STORAGE_PROVIDER, type FileStorageProvider } from './file-storage.types';
import { LocalStorageProvider } from './local-storage.provider';
import { MalwareScannerService } from './malware-scanner.service';
import { S3StorageProvider } from './s3-storage.provider';

@Global()
@Module({
  providers: [
    {
      provide: FILE_STORAGE_PROVIDER,
      inject: [AppConfigService],
      // Local filesystem is the working driver (single VPS). The root must exist on a persistent
      // mount and be writable by the container user; startup fails loudly otherwise.
      useFactory: async (config: AppConfigService): Promise<FileStorageProvider> => {
        if (config.get('FILE_STORAGE_DRIVER') === 's3') return new S3StorageProvider();
        const local = new LocalStorageProvider(config.get('FILE_STORAGE_LOCAL_DIR'));
        try {
          await local.ensureReady();
        } catch (err) {
          throw new Error(
            `FILE_STORAGE_LOCAL_DIR is not writable (${(err as Error).message}). Check the mount and its owner (UID of the container user).`,
          );
        }
        return local;
      },
    },
    MalwareScannerService,
  ],
  exports: [FILE_STORAGE_PROVIDER, MalwareScannerService],
})
export class FileStorageModule {}
