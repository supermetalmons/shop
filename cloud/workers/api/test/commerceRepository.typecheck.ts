import { commerceKeys, type D1CommerceRepository, type CommerceUnitOfWork } from '../src/commerceRepository.js';
import { publicRecord, type StoredDocument } from '../src/commerceDocumentCodec.js';

function rawReadContracts(repository: D1CommerceRepository, transaction: CommerceUnitOfWork, stored: StoredDocument): void {
  const key = commerceKeys.deliveryOrder('drop', '1');
  // @ts-expect-error Repository reads cannot assert an unchecked document shape.
  void repository.get<{ owner: string }>(key);
  // @ts-expect-error Workflow status reads cannot assert an unchecked document shape.
  void repository.getAdminIrlRedeemRequestForWorkflowStatus<{ owner: string }>('operation');
  // @ts-expect-error Transaction reads cannot assert an unchecked document shape.
  void transaction.get<{ owner: string }>(key);
  // @ts-expect-error Batched reads cannot assert an unchecked document shape.
  void transaction.getMany<{ owner: string }>([key]);
  // @ts-expect-error Query results must be parsed before their fields are narrowed.
  void transaction.queryDeliveryOrdersByOwner<{ owner: string }>({ owner: 'wallet', limit: 1 });
  // @ts-expect-error Cloning a document does not validate its domain fields.
  void publicRecord<{ owner: string }>(stored);

  const record = publicRecord(stored);
  // @ts-expect-error A raw stored owner has not been validated as a string.
  const owner: string = record.data.owner;
  void owner;
}

void rawReadContracts;
