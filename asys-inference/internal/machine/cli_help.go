package machine

func commandHelp(command string) string {
	usage := map[string]string{
		"init": `init [--system NAME] [--dcomp-state-root DIRECTORY] [--runtime-root DIRECTORY]
  [--prefix NAME] [--components-root DIRECTORY] [--empty]

Create inference configuration. Start it separately with start.
--system selects the dcomp namespace (default: asys).
--dcomp-state-root selects dcomp state (default: DCOMP_STATE_ROOT or dcomp default).
--runtime-root selects the dcomp proxy/socket directory (default: dcomp default).
--prefix names owned components (default: asys-inference).
--components-root selects component sources; the installed sources are the default.
--empty omits the initial gateway so you can add your own provider network.
`,
		"start": "start\n\nStart configured providers and export the selected output as @inference_endpoint.\n",
		"stop":  "stop\n\nStop owned providers and unbind the inference endpoint. Configuration is retained.\n",
		"add": `add NAME SOURCE [ARGUMENTS...] [-L INPUT=TARGET]

Add a provider, select its Provider output and apply the updated network.
NAME is the instance name. SOURCE is a component name or component.dcomp directory.
-L/--link connects an input to NAME.OUTPUT or @GLOBAL; repeat for several inputs.
Use -- before literal component arguments that conflict with host options.
Example: asys-inference add cache passthrough -L upstream=gateway.provider
`,
		"remove":     "remove NAME\n\nRemove a configured provider and its connections; unbind the endpoint if selected.\n",
		"select":     "select NAME[.OUTPUT]|-\n\nExport this provider output as @inference_endpoint. Use - to unbind it.\n",
		"components": "components [--json] [--components-root DIRECTORY]\n\nList available component sources and interfaces. Does not create or change state.\n",
		"show":       "show [--json]\n\nRead saved provider configuration and the selected endpoint. Does not apply changes.\n",
		"status":     "status [--json]\n\nInspect provider health, the active endpoint and recent failures. Does not apply changes.\n",
		"models":     "models [--json]\n\nQuery model IDs exported by @inference_endpoint. --json includes model metadata.\n",
		"gateway": `gateway [--name NAME] COMMAND

Administer the gateway instance (default name: gateway).
  providers                       List authentication providers
  models                          List gateway model IDs
  usage                           Show account usage
  login PROVIDER --as ACCOUNT      Authenticate an account
    [--authentication auto|oauth|api_key]
    [--api-key-env VARIABLE | --api-key-stdin] [--non-interactive]
  logout ACCOUNT                  Remove account authentication
  rename ACCOUNT NEW_NAME         Rename an account

Use provider IDs from providers. --api-key-env names a host variable; it does
not take the key itself. Login credentials are kept in inference state.
`,
	}[command]
	return "Usage: asys-inference " + usage + "\n--root DIRECTORY selects asys state; inference uses DIRECTORY/inference.\n" +
		"Default: ASYS_STATE_ROOT, then XDG_STATE_HOME/asys, then ~/.local/state/asys.\n"
}
