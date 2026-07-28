-- Domain audit events are append-only.
CREATE FUNCTION "prevent_domain_audit_event_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DomainAuditEvent is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DomainAuditEvent_prevent_update"
  BEFORE UPDATE ON "DomainAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();

CREATE TRIGGER "DomainAuditEvent_prevent_delete"
  BEFORE DELETE ON "DomainAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_domain_audit_event_mutation"();
