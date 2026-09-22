import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DOCUMENT_STORAGE } from './document-storage.js';
import { LocalDocumentStorage } from './local-document-storage.js';
import { UploadController } from './upload.controller.js';

@Global()
@Module({
  controllers: [UploadController],
  providers: [
    {
      provide: DOCUMENT_STORAGE,
      inject: [ENV],
      useFactory: (env: Env) =>
        new LocalDocumentStorage(env.STORAGE_DIR, env.DATA_ENCRYPTION_KEY, env.PUBLIC_API_URL),
    },
  ],
  exports: [DOCUMENT_STORAGE],
})
export class StorageModule {}
