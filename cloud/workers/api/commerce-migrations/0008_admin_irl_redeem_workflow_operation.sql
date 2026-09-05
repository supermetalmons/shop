CREATE INDEX commerce_admin_irl_redeem_workflow_operation
  ON commerce_documents (
    json_extract(document_json, '$.workflowFinalizeV1.operationId'),
    document_path
  )
  WHERE document_kind = 'admin_irl_redeem_request';

ANALYZE commerce_admin_irl_redeem_workflow_operation;
