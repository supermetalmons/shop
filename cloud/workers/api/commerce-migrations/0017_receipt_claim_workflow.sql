CREATE UNIQUE INDEX commerce_receipt_claim_workflow_operation
  ON commerce_documents (json_extract(document_json, '$.receiptClaimWorkflowV1.operationId'))
  WHERE document_kind = 'claim_code';

CREATE INDEX commerce_receipt_claim_workflow_due
  ON commerce_documents (
    json_extract(document_json, '$.receiptClaimWorkflowV1.nextAttemptAtMs'),
    document_path
  )
  WHERE document_kind = 'claim_code'
    AND json_extract(document_json, '$.receiptClaimWorkflowV1.phase') = 'pending';

ANALYZE commerce_receipt_claim_workflow_operation;
ANALYZE commerce_receipt_claim_workflow_due;
