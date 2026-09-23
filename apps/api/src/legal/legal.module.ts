import { Module } from '@nestjs/common';
import {
  ConsentController,
  LegalAdminController,
  LegalDocumentsController,
} from './legal.controller.js';
import { LegalService } from './legal.service.js';

@Module({
  controllers: [LegalDocumentsController, ConsentController, LegalAdminController],
  providers: [LegalService],
  exports: [LegalService],
})
export class LegalModule {}
