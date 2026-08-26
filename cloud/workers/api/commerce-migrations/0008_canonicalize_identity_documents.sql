SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM commerce_documents AS document
  WHERE EXISTS (
    SELECT 1
    FROM json_tree(document.document_json) AS identity
    WHERE
      identity.key IN ('firebaseUid', 'mergedFirebaseUid') OR
      (
        identity.type = 'text' AND
        (identity.atom = 'firebase' OR substr(identity.atom, 1, 9) = 'firebase:')
      )
  ) AND NOT (
    (
      json_type(document.document_json, '$.firebaseUid') = 'text' AND
      length(json_extract(document.document_json, '$.firebaseUid')) > 0 AND
      json_type(document.document_json, '$.mergedFirebaseUid') IS NULL AND
      json_type(document.document_json, '$.authSubject') IS NULL AND
      json_type(document.document_json, '$.mergedAuthSubject') IS NULL AND
      json_extract(document.document_json, '$.ownerKind') = 'firebase' AND
      json_extract(document.document_json, '$.owner') =
        'firebase:' || json_extract(document.document_json, '$.firebaseUid') AND
      json_type(document.document_json, '$.previousOwner') IS NULL AND
      NOT EXISTS (
        SELECT 1
        FROM json_tree(document.document_json) AS identity
        WHERE (
          identity.key IN ('firebaseUid', 'mergedFirebaseUid', 'authSubject', 'mergedAuthSubject') OR
          (
            identity.type = 'text' AND
            (identity.atom = 'firebase' OR substr(identity.atom, 1, 9) = 'firebase:')
          )
        ) AND identity.fullkey NOT IN ('$.firebaseUid', '$.owner', '$.ownerKind')
      )
    ) OR
    (
      json_type(document.document_json, '$.firebaseUid') = 'text' AND
      length(json_extract(document.document_json, '$.firebaseUid')) > 0 AND
      json_type(document.document_json, '$.mergedFirebaseUid') = 'text' AND
      json_extract(document.document_json, '$.mergedFirebaseUid') =
        json_extract(document.document_json, '$.firebaseUid') AND
      json_type(document.document_json, '$.authSubject') IS NULL AND
      json_type(document.document_json, '$.mergedAuthSubject') IS NULL AND
      json_extract(document.document_json, '$.ownerKind') = 'firebase' AND
      json_type(document.document_json, '$.owner') = 'text' AND
      length(json_extract(document.document_json, '$.owner')) > 0 AND
      json_extract(document.document_json, '$.owner') <>
        'firebase:' || json_extract(document.document_json, '$.firebaseUid') AND
      json_extract(document.document_json, '$.previousOwner') =
        'firebase:' || json_extract(document.document_json, '$.firebaseUid') AND
      NOT EXISTS (
        SELECT 1
        FROM json_tree(document.document_json) AS identity
        WHERE (
          identity.key IN ('firebaseUid', 'mergedFirebaseUid', 'authSubject', 'mergedAuthSubject') OR
          (
            identity.type = 'text' AND
            (identity.atom = 'firebase' OR substr(identity.atom, 1, 9) = 'firebase:')
          )
        ) AND identity.fullkey NOT IN (
          '$.firebaseUid',
          '$.mergedFirebaseUid',
          '$.ownerKind',
          '$.previousOwner'
        )
      )
    )
  )
) THEN json('invalid commerce identity document') ELSE NULL END;

UPDATE commerce_documents
SET document_json = json_set(
  json_remove(document_json, '$.firebaseUid'),
  '$.authSubject', json_extract(document_json, '$.firebaseUid'),
  '$.owner', 'anonymous:' || json_extract(document_json, '$.firebaseUid'),
  '$.ownerKind', 'anonymous'
)
WHERE
  json_type(document_json, '$.firebaseUid') = 'text' AND
  json_type(document_json, '$.mergedFirebaseUid') IS NULL;

UPDATE commerce_documents
SET document_json = json_set(
  json_remove(document_json, '$.firebaseUid', '$.mergedFirebaseUid'),
  '$.mergedAuthSubject', json_extract(document_json, '$.firebaseUid'),
  '$.ownerKind', 'wallet',
  '$.previousOwner', 'anonymous:' || json_extract(document_json, '$.firebaseUid')
)
WHERE
  json_type(document_json, '$.firebaseUid') = 'text' AND
  json_type(document_json, '$.mergedFirebaseUid') = 'text';
