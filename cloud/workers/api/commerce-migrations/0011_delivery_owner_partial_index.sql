DROP INDEX commerce_documents_delivery_owner_path;

CREATE INDEX commerce_documents_delivery_owner_path
  ON commerce_documents (owner, document_path)
  WHERE document_kind = 'delivery_order';

PRAGMA optimize;
