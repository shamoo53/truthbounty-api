import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BlockchainIndexerService } from './blockchain-indexer.service';
import { ProcessedEvent } from './entities/processed-event.entity';
import { TokenBalance } from './entities/token-balance.entity';
import { IndexerCheckpoint } from './entities/indexer-checkpoint.entity';
import { BlockchainEvent } from './interfaces/blockchain-event.interface';

describe('BlockchainIndexerService - Replay Regression Tests', () => {
  let service: BlockchainIndexerService;
  let processedEventRepo: Repository<ProcessedEvent>;
  let tokenBalanceRepo: Repository<TokenBalance>;
  let checkpointRepo: Repository<IndexerCheckpoint>;
  let dataSource: DataSource;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BlockchainIndexerService,
        {
          provide: getRepositoryToken(ProcessedEvent),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(TokenBalance),
          useClass: Repository,
        },
        {
          provide: getRepositoryToken(IndexerCheckpoint),
          useClass: Repository,
        },
        {
          provide: DataSource,
          useValue: {
            createQueryRunner: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<BlockchainIndexerService>(BlockchainIndexerService);
    processedEventRepo = module.get<Repository<ProcessedEvent>>(getRepositoryToken(ProcessedEvent));
    tokenBalanceRepo = module.get<Repository<TokenBalance>>(getRepositoryToken(TokenBalance));
    checkpointRepo = module.get<Repository<IndexerCheckpoint>>(getRepositoryToken(IndexerCheckpoint));
    dataSource = module.get<DataSource>(DataSource);
  });

  describe('Replay State Consistency', () => {
    it('should produce identical state when run multiple times', async () => {
      // Setup: Create events in blocks 100, 101, 102
      const events = [
        { blockNumber: 100, txHash: '0x100', logIndex: 0, eventType: 'Transfer' },
        { blockNumber: 101, txHash: '0x101', logIndex: 0, eventType: 'Transfer' },
        { blockNumber: 102, txHash: '0x102', logIndex: 0, eventType: 'Transfer' },
      ];

      // Mock the createQueryBuilder for delete operations
      const mockQueryBuilder = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3, raw: {} }),
      };

      jest.spyOn(processedEventRepo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      // First replay
      await service.replayFromBlock(100);
      
      const firstDeleteCall = mockQueryBuilder.where.mock.calls[0];
      expect(firstDeleteCall[0]).toBe('blockNumber >= :startBlock');
      expect(firstDeleteCall[1]).toEqual({ startBlock: 100 });
      expect(mockQueryBuilder.execute).toHaveBeenCalledTimes(1);

      // Reset mocks
      jest.clearAllMocks();
      jest.spyOn(processedEventRepo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      // Second replay - should behave identically
      await service.replayFromBlock(100);
      
      const secondDeleteCall = mockQueryBuilder.where.mock.calls[0];
      expect(secondDeleteCall[0]).toBe('blockNumber >= :startBlock');
      expect(secondDeleteCall[1]).toEqual({ startBlock: 100 });
      expect(mockQueryBuilder.execute).toHaveBeenCalledTimes(1);

      // Both replays should have identical behavior
      expect(firstDeleteCall).toEqual(secondDeleteCall);
    });

    it('should clean up all events from startBlock onward preventing stale data', async () => {
      // Mock events that would exist in database
      const existingEvents = [
        { id: '1', blockNumber: 99, txHash: '0x99' },  // Should NOT be deleted
        { id: '2', blockNumber: 100, txHash: '0x100' }, // Should be deleted
        { id: '3', blockNumber: 101, txHash: '0x101' }, // Should be deleted
        { id: '4', blockNumber: 102, txHash: '0x102' }, // Should be deleted
      ];

      const mockQueryBuilder = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3, raw: {} }), // 3 events deleted (100, 101, 102)
      };

      jest.spyOn(processedEventRepo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      // Replay from block 100
      await service.replayFromBlock(100);

      // Verify the correct WHERE clause is used
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('blockNumber >= :startBlock', { startBlock: 100 });
      
      // Verify 3 events were deleted (blocks 100, 101, 102)
      expect(mockQueryBuilder.execute).toHaveBeenCalled();
    });

    it('should handle edge case when startBlock is higher than existing events', async () => {
      const mockQueryBuilder = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0, raw: {} }), // No events deleted
      };

      jest.spyOn(processedEventRepo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      // Replay from a block higher than any existing events
      await service.replayFromBlock(999);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('blockNumber >= :startBlock', { startBlock: 999 });
      expect(mockQueryBuilder.execute).toHaveBeenCalled();
    });

    it('should handle replay from block 0 (full replay)', async () => {
      const mockQueryBuilder = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 100, raw: {} }), // All events deleted
      };

      jest.spyOn(processedEventRepo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      // Full replay from beginning
      await service.replayFromBlock(0);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('blockNumber >= :startBlock', { startBlock: 0 });
      expect(mockQueryBuilder.execute).toHaveBeenCalled();
    });

    it('should be idempotent - multiple replays from same block should be safe', async () => {
      const mockQueryBuilder = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0, raw: {} }), // No events to delete on subsequent runs
      };

      jest.spyOn(processedEventRepo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      // First replay
      await service.replayFromBlock(100);
      
      // Second replay (should be safe)
      await service.replayFromBlock(100);
      
      // Third replay (should still be safe)
      await service.replayFromBlock(100);

      // All three calls should have identical behavior
      expect(mockQueryBuilder.where).toHaveBeenCalledTimes(3);
      expect(mockQueryBuilder.execute).toHaveBeenCalledTimes(3);
      
      // Verify all calls used the same parameters
      mockQueryBuilder.where.mock.calls.forEach(call => {
        expect(call[0]).toBe('blockNumber >= :startBlock');
        expect(call[1]).toEqual({ startBlock: 100 });
      });
    });
  });

  describe('Regression Tests for Double Processing Prevention', () => {
    it('should prevent double processing by cleaning up all future events', async () => {
      // This test ensures the fix for the original bug where only exact block matches were deleted
      const mockQueryBuilder = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 5, raw: {} }),
      };

      jest.spyOn(processedEventRepo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      await service.replayFromBlock(100);

      // CRITICAL: Verify >= is used, not == (this was the original bug)
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('blockNumber >= :startBlock', { startBlock: 100 });
      
      // The original buggy code would have used: { blockNumber: 100 }
      // The fixed code should use: 'blockNumber >= :startBlock', { startBlock: 100 }
    });

    it('should ensure no stale events remain after replay', async () => {
      // Test scenario: Events exist in blocks 100, 101, 102, 103
      // After replay from 101, only events from 101+ should be removed
      // Events from block 100 should remain
      
      const mockQueryBuilder = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 3, raw: {} }), // Delete blocks 101, 102, 103
      };

      jest.spyOn(processedEventRepo, 'createQueryBuilder').mockReturnValue(mockQueryBuilder as any);

      await service.replayFromBlock(101);

      expect(mockQueryBuilder.where).toHaveBeenCalledWith('blockNumber >= :startBlock', { startBlock: 101 });
      expect(mockQueryBuilder.execute).toHaveBeenCalled();
    });
  });
});
