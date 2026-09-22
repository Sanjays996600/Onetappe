import { Module } from '@nestjs/common';
import { SafetyService } from './safety.service.js';
import { SupportService } from './support.service.js';

@Module({ providers: [SupportService, SafetyService], exports: [SupportService, SafetyService] })
export class SupportModule {}
