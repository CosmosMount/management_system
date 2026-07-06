-- Finance roles are now scoped by team instead of techGroup.
-- Legacy techGroup-scoped assignments must be recreated per team in admin UI.
DELETE FROM "UserRole"
WHERE role = 'FINANCE' AND "techGroup" <> '' AND team = '';
