import { Global, Module } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { FILE_STORAGE_PROVIDER, type FileStorageProvider } from './file-storage.types';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';

@Global()
@Module({
  providers: [
    {
      provide: FILE_STORAGE_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): FileStorageProvider =>
        config.get('FILE_STORAGE_DRIVER') === 's3'
          ? new S3StorageProvider()
          : new LocalStorageProvider(config.get('FILE_STORAGE_LOCAL_DIR')),
    },
  ],
  exports: [FILE_STORAGE_PROVIDER],
})
export class FileStorageModule {}
