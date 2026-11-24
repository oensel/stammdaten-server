-- Neuer Scope mitglieder:import (Mitglieder-Import aus dem DJB-Export): in allen Apps erlaubt, vergeben nur an Admins
update anwendungen set scopes = scopes || '{mitglieder:import}' where not ('mitglieder:import' = any(scopes));
