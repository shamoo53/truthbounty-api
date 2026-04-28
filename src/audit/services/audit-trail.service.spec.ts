import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { REQUEST } from '@nestjs/core';
import { AuditTrailService } from './audit-trail.service';
import { AuditLog, AuditActionType, AuditEntityType } from '../entities/audit-log.entity';

describe('AuditTrailService', () => {
  let service: AuditTrailService;
  let auditLogRepo: Repository<AuditLog>;

  const mockRequest = {
    get: jest.fn().mockReturnValue('test-user-agent'),
    headers: {},
    ip: '127.0.0.1',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditTrailService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: REQUEST,
          useValue: mockRequest,
        },
      ],
    }).compile();

    service = module.get<AuditTrailService>(AuditTrailService);
    auditLogRepo = module.get<Repository<AuditLog>>(getRepositoryToken(AuditLog));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('log', () => {
    const mockInput = {
      actionType: AuditActionType.CLAIM_CREATED,
      entityType: AuditEntityType.CLAIM,
      entityId: 'test-entity-id',
      userId: 'test-user-id',
      description: 'Test audit log',
    };

    it('should log audit successfully', async () => {
      const mockAuditLog = { id: '1', ...mockInput };
      jest.spyOn(auditLogRepo, 'create').mockReturnValue(mockAuditLog as any);
      jest.spyOn(auditLogRepo, 'save').mockResolvedValue(mockAuditLog as any);

      await expect(service.log(mockInput)).resolves.not.toThrow();
      expect(auditLogRepo.create).toHaveBeenCalled();
      expect(auditLogRepo.save).toHaveBeenCalledWith(mockAuditLog);
    });

    it('should not throw when DB save fails', async () => {
      const mockAuditLog = { id: '1', ...mockInput };
      jest.spyOn(auditLogRepo, 'create').mockReturnValue(mockAuditLog as any);
      jest.spyOn(auditLogRepo, 'save').mockRejectedValue(new Error('DB error'));

      // The log method should not throw even if save fails
      await expect(service.log(mockInput)).resolves.not.toThrow();
      expect(auditLogRepo.create).toHaveBeenCalled();
      expect(auditLogRepo.save).toHaveBeenCalledWith(mockAuditLog);
    });
  });
});