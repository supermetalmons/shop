CREATE TABLE commerce_delivery_owner_revisions (
  owner TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991)
) STRICT;

CREATE TRIGGER commerce_delivery_owner_revision_insert_guard
BEFORE INSERT ON commerce_delivery_owner_revisions
WHEN EXISTS (
  SELECT 1 FROM commerce_delivery_owner_revisions
  WHERE owner = NEW.owner AND revision > NEW.revision
)
BEGIN
  SELECT RAISE(ABORT, 'commerce delivery-owner revisions cannot move backward');
END;

CREATE TRIGGER commerce_delivery_owner_revision_delete_guard
BEFORE DELETE ON commerce_delivery_owner_revisions
BEGIN
  SELECT RAISE(ABORT, 'commerce delivery-owner revision tombstones cannot be deleted');
END;

CREATE TRIGGER commerce_delivery_owner_revision_update_guard
BEFORE UPDATE ON commerce_delivery_owner_revisions
WHEN NEW.owner IS NOT OLD.owner OR NEW.revision <= OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'commerce delivery-owner revisions must increase in place');
END;

ALTER TABLE commerce_commit_guards
ADD COLUMN delivery_owner_expectations_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(delivery_owner_expectations_json) AND
    json_type(delivery_owner_expectations_json) = 'array'
  );

CREATE TRIGGER commerce_delivery_owner_revision_insert
AFTER INSERT ON commerce_documents
WHEN NEW.document_kind = 'delivery_order' AND NEW.owner IS NOT NULL
BEGIN
  INSERT INTO commerce_delivery_owner_revisions (owner, revision)
  VALUES (
    NEW.owner,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(owner) DO UPDATE SET revision = excluded.revision
  WHERE commerce_delivery_owner_revisions.revision < excluded.revision;
END;

CREATE TRIGGER commerce_delivery_owner_revision_delete
AFTER DELETE ON commerce_documents
WHEN OLD.document_kind = 'delivery_order' AND OLD.owner IS NOT NULL
BEGIN
  INSERT INTO commerce_delivery_owner_revisions (owner, revision)
  VALUES (
    OLD.owner,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(owner) DO UPDATE SET revision = excluded.revision
  WHERE commerce_delivery_owner_revisions.revision < excluded.revision;
END;

CREATE TRIGGER commerce_delivery_owner_revision_departure
AFTER UPDATE OF document_kind, document_json ON commerce_documents
WHEN
  OLD.document_kind = 'delivery_order' AND
  OLD.owner IS NOT NULL AND
  (
    NEW.document_kind <> 'delivery_order' OR
    NEW.owner IS NOT OLD.owner
  )
BEGIN
  INSERT INTO commerce_delivery_owner_revisions (owner, revision)
  VALUES (
    OLD.owner,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(owner) DO UPDATE SET revision = excluded.revision
  WHERE commerce_delivery_owner_revisions.revision < excluded.revision;
END;

CREATE TRIGGER commerce_delivery_owner_revision_arrival
AFTER UPDATE OF document_kind, document_json ON commerce_documents
WHEN
  NEW.document_kind = 'delivery_order' AND
  NEW.owner IS NOT NULL AND
  (
    OLD.document_kind <> 'delivery_order' OR
    NEW.owner IS NOT OLD.owner
  )
BEGIN
  INSERT INTO commerce_delivery_owner_revisions (owner, revision)
  VALUES (
    NEW.owner,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(owner) DO UPDATE SET revision = excluded.revision
  WHERE commerce_delivery_owner_revisions.revision < excluded.revision;
END;

CREATE TRIGGER commerce_delivery_owner_revision_path
AFTER UPDATE OF document_path ON commerce_documents
WHEN
  OLD.document_kind = 'delivery_order' AND
  NEW.document_kind = 'delivery_order' AND
  OLD.owner IS NEW.owner AND
  NEW.owner IS NOT NULL AND
  OLD.document_path IS NOT NEW.document_path
BEGIN
  INSERT INTO commerce_delivery_owner_revisions (owner, revision)
  VALUES (
    NEW.owner,
    (SELECT documents_revision + 1 FROM commerce_authority_control WHERE singleton = 1)
  )
  ON CONFLICT(owner) DO UPDATE SET revision = excluded.revision
  WHERE commerce_delivery_owner_revisions.revision < excluded.revision;
END;

CREATE TRIGGER commerce_documents_version_update_guard
AFTER UPDATE ON commerce_documents
WHEN NEW.version <= OLD.version
BEGIN
  SELECT RAISE(ABORT, 'commerce transaction conflict: commerce document version must increase');
END;

DROP TRIGGER commerce_commit_guard_validate;

CREATE TRIGGER commerce_commit_guard_validate
BEFORE INSERT ON commerce_commit_guards
BEGIN
  SELECT (CASE WHEN (
    SELECT authority_state FROM commerce_authority_control WHERE singleton = 1
  ) <> 'd1' THEN RAISE(ABORT, 'commerce authority is not d1') END);

  SELECT (CASE WHEN NEW.expected_documents_revision IS NOT NULL AND NEW.expected_documents_revision <> (
    SELECT documents_revision FROM commerce_authority_control WHERE singleton = 1
  ) THEN RAISE(ABORT, 'commerce transaction conflict') END);

  SELECT (CASE WHEN
    EXISTS (
      SELECT 1
      FROM json_each(NEW.delivery_owner_expectations_json) AS expectation
      LEFT JOIN commerce_delivery_owner_revisions AS owner_revision
        ON owner_revision.owner = json_extract(expectation.value, '$.owner')
      WHERE
        json_type(expectation.value) IS NOT 'object' OR
        (SELECT COUNT(*) FROM json_each(expectation.value)) <> 2 OR
        json_type(expectation.value, '$.owner') IS NOT 'text' OR
        length(json_extract(expectation.value, '$.owner')) < 1 OR
        json_type(expectation.value, '$.revision') IS NOT 'integer' OR
        CAST(json_extract(expectation.value, '$.revision') AS INTEGER)
          NOT BETWEEN 0 AND 9007199254740991 OR
        COALESCE(owner_revision.revision, 0) <>
          CAST(json_extract(expectation.value, '$.revision') AS INTEGER)
    ) OR
    (
      SELECT COUNT(*)
      FROM json_each(NEW.delivery_owner_expectations_json)
    ) <> (
      SELECT COUNT(DISTINCT json_extract(expectation.value, '$.owner'))
      FROM json_each(NEW.delivery_owner_expectations_json) AS expectation
    )
  THEN RAISE(ABORT, 'commerce transaction conflict') END);

  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM json_each(NEW.expectations_json) AS expectation
    LEFT JOIN commerce_documents AS document
      ON document.document_path = json_extract(expectation.value, '$.path')
    WHERE COALESCE(document.version, -1) <> CAST(json_extract(expectation.value, '$.version') AS INTEGER)
  ) THEN RAISE(ABORT, 'commerce transaction conflict') END);
END;

PRAGMA optimize;
