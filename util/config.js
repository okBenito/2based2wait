// =======
// Imports
// =======

const fs = require("fs");

const merge = require("deepmerge");
const JSON5 = require("json5");
const joi = require("joi");

// ===========
// Global Vars
// ===========

var config = {}; // Stores parsed and validated user configuration
var status = { // Stores pertinent information (to-do: set up setters and getters)
	"position": "CHECKING...",
	"eta": "CHECKING...",
	"restart": "None",
	"mineflayer": "CHECKING...",
	"inQueue": "true",
	"ngrokUrl": "None",
	"livechatRelay": "false",
	"controller": "None"
};

// =======
// Schemas
// =======

// Schema used to validate Minecraft usernames (between 3 and 16 characters, containing only a-z, A-Z, 0-9, and _)
const usernameSchema = joi.string().min(3).max(16).token();

// Schema used to validate packet names (lowercase, consisting only of a-z and underscores)
const packetSchema = joi.string().pattern(/^[a-z_]*$/).lowercase();

// Schema used to validate Discord webhooks (to-do: update this to only recognize webhooks)
const webhookSchema = joi.string().empty("").default("");

// Schema used to validate a handful of the most important Zlib options, based off of information available on https://zlib.net/manual.html
const zlibOptionsSchema = joi.object({
	"level": joi.number().integer().min(1).max(9).default(1)
		.description("How much compression to apply between 1 and 9. Higher values result in better compression ratio at the expense of speed (**\[Warning, Event Thread-Blocking!\]**)"),
	"memLevel": joi.number().integer().min(1).max(9).default(9)
		.description("How much memory to allocate to the internal compression state between 1 and 9. Higher values result in better compression ratio and speed at the expense of memory usage"),
	"windowBits": joi.number().integer().min(8).max(15).default(15)
		.description("How much memory to allocate to the history buffer between 8 and 15. Higher values result in better compression ratio at the expense of memory usage"),
}).default();

// Schema used to validate config.json
const configSchema = joi.object({
	"account": joi.object({
		"username": usernameSchema.required()
			.description("The in-game playername of the account"),
		"password": joi.string().empty("").default("")
			.description("The password of the account (only required for Mojang accounts, leave it empty for Microsoft accounts. Microsoft accounts will just get instructions in the console to put a token into [microsoft.com/link](https://microsoft.com/link)"), // to-do: add a mojang password regex
		"auth": joi.string().valid("microsoft", "mojang", "offline").default("microsoft")
			.description("Authentication type (options: 'microsoft', 'mojang', 'offline')")
	}).default(),
	"discord": joi.object({
		"active": joi.boolean().default(false)
			.description("Whether to send Discord webhooks"),
		"webhook": joi.object({
			"spam": webhookSchema
				.description("Url of webhook to relay position in queue, new tunnels, connects/disconnects, and other spam"),
			"livechat": webhookSchema
				.description("Url of webhook to relay livechat"),
			"status": webhookSchema
				.description("Url of webhook to relay pertinent info for connecting and nothing else (e.g. joining server, low queue position)")
		}).default(),
		"color": joi.number().integer().min(0).max(16777215).default(2123412)
			.description("Color of Discord embeds sent to the webhooks in **decimal value** (you can use convertingcolors.com to find the decimal value of a color you want)"),
		"id": joi.string().default(0) // although this can be an number for users, it can be a string for roles!
			.description("ID of the Discord user or role to ping when below the queueThreshold")
	}).default(),
	"queueThreshold": joi.number().integer().min(0).default(21)
		.description("Minimum queue position before toast notifications & Discord pings start getting sent"),
	"reconnectInterval": joi.number().positive().default(69)
		.description("Time (in seconds) between each reconnection attempt (see: [How to Auto-Reconnect with Supervisor](https://github.com/Enchoseon/2based2wait/wiki/How-to-Auto-Reconnect-with-Supervisor))"),
	"uncleanDisconnectInterval": joi.number().positive().default(420)
		.description("Time (in seconds) proxy will go without getting a single packet from 2B2T before assuming it was uncleanly disconnected and initiating a reconnect attempt"),
	"log": joi.object({
		"active": joi.object({
			"error": joi.boolean().default(true)
				.description("Whether to log errors"),
			"proxy": joi.boolean().default(true)
				.description("Whether to log proxy status (e.g. connecting to server, starting Mineflayer, etc.)"),
			"chat": joi.boolean().default(true)
				.description("Whether to log chat"),
			"bridgeClientPackets": joi.boolean().default(true)
				.description("Whether to log packets being sent from the controller to the proxy"),
			"serverPackets": joi.boolean().default(true)
				.description("Whether to log packets being sent from 2b2t to the proxy"),
		}).default()
			.description("Settings for which logging categories should be enabled"),
		"cutoff": joi.number().integer().positive().default(69000) // Not setting a minimum for this seems dangerous...
			.description("Maximum size a log file can be (in bytes) before it gets split up"),
		"packetFilters": joi.object({
			"server": joi.array().items(packetSchema).default(["map", "map_chunk", "player_info", "entity_metadata", "entity_velocity", "entity_move_look", "entity_look", "update_time", "world_particles", "unload_chunk", "teams", "rel_entity_move", "entity_head_rotation", "entity_update_attributes", "block_change"])
				.description("Packets being sent from 2b2t to not log"),
			"bridgeClient": joi.array().items(packetSchema).default(["position", "look", "position_look", "arm_animation"])
				.description("Packets being sent from the controller to not log")
		}).default()
			.description("Settings for which packets we shouldn't log"),
		"compression": joi.object({
			"active": joi.boolean().default(false)
				.description("**\[Warning, Event Thread-Blocking!\]** Whether to compress log files with Gzip. Leave this off unless you have a really good reason to enable it"),
		}).concat(zlibOptionsSchema).default()
			.description("Settings for log compression. Tweak with caution. The default options maximize memory usage for the fastest speed"),
		"alwaysIncrement": joi.boolean().default(false)
				.description("Whether to increment the log file every session (can lead to thousands of 1kb log files in production, but is pretty useful when rapidly testing during development)"),
	}).default(),
	"server": joi.object({
		"host": joi.string().hostname().default("connect.2b2t.org")
			.description("Address of the server to connect to"),
		"version": joi.string().default("1.12.2") // to-do: regex idea: must start with a number and contain only numbers & decimals?
			.description("Version of Minecraft the server is on "),
		"port": joi.number().port().default(25565)
			.description("Port of the server to connect to")
	}).default()
		.description("Settings for how the proxy connects to the server"),
	"proxy": joi.object({
		"whitelist": joi.array().items(usernameSchema)
			.description("Playernames of accounts that are allowed to connect to the proxy"),
		"onlineMode": joi.boolean().default(true)
			.description("Whether to enable online-mode on the proxy. This probably should never be touched"),
		"port": joi.number().port().default(25565)
			.description("Port on the machine to connect to the proxy")
	}).default()
		.description("Settings for how you connect to the proxy"),
	"ngrok": joi.object({
		"active": joi.boolean().default(false)
			.description("Whether to create an ngrok tunnel"),
		"authtoken": joi.string().empty("").pattern(/[A-Za-z0-9\-\._~\+\/]+=*/).default("") // (Bearer Token Regex) From: https://www.regextester.com/95017
			.description("The auth token for your Ngrok.io account"),
		"region": joi.string().valid("us", "eu", "au", "ap", "sa", "jp", "in").default("us") // From: https://ngrok.com/docs/ngrok-agent/ (under "--region string")
			.description("Tunnel region (options: 'us', 'eu', 'au', 'ap', 'sa', 'jp', or 'in')")
	}).default()
		.description("Settings for ngrok tunneling"),
	"mineflayer": joi.object({
		"active": joi.boolean().default(true)
			.description("Whether to enable Mineflayer"),
		"autoQueueMainInterval": joi.number().positive().default(690) // Not setting a minimum for this seems dangerous...
			.description("Time (in seconds) between every `/queue main` command"),
		"killAura": joi.object({
			"interval": joi.number().positive().default(0.69)
				.description("Time (in seconds) between every attack attempt"),
			"blacklist": joi.array().items(packetSchema).default(["zombie_pigman", "enderman"])
				.description("Array of mobs that will not be attacked")
		}).default()
			.description("Settings for killaura"),
		"autoEat": joi.object({
			"priority": joi.string().valid("saturation", "foodPoints", "effectiveQuality").default("saturation") // From: https://github.com/link-discord/mineflayer-auto-eat#botautoeatoptionspriority
				.description("What type of food to prioritize eating (options: 'saturation', 'foodPoints', 'effectiveQuality')"),
			"startAt": joi.number().integer().min(0).default(19)
				.description("Hunger level at which to start eating"),
			"bannedFood": joi.array().items(packetSchema).default(["rotten_flesh", "pufferfish", "chorus_fruit", "poisonous_potato", "spider_eye"])
				.description("Foods that will not be eaten")
		}).default()
			.description("Settings for autoeat"),
		"antiAfk": joi.object({
			"actions": joi.array().items(joi.string().valid("rotate", "walk", "jump", "jumpWalk", "swingArm", "breakBlock")).default(["rotate"])
				.description("Actions the proxy can do (options: 'rotate', 'walk', 'jump', 'jumpWalk', 'swingArm', 'breakBlock')"),
			"fishing": joi.boolean().default(false)
				.description("Whether the proxy will fish. The account must be standing in water and have a fishing rod to autofish."),
			"chatting": joi.boolean().default(false)
				.description("Whether the proxy will chat"),
			"chatMessages": joi.array().items(joi.string().min(1).max(256)).default(["!pt", "!queue"]) // to-do: find out any other chat limits
				.description("Chat messages that the proxy will send if chatting is enabled"),
			"chatInterval": joi.number().integer().positive().default(690420) // Not setting a minimum for this seems dangerous...
				.description("Time (in milliseconds) between each chat message")
		}).default()
			.description("Settings for antiafk")
	}).default()
		.description("Settings for the mineflayer bot"),
	"experimental": joi.object({
		"spoofPlayerInfo": joi.object({
			"active": joi.boolean().default(true)
				.description("Whether to spoof the [Player Info packet](https://wiki.vg/Protocol#Player_Info) to set a custom skin"),
			"texture": joi.object({ // From: https://wiki.vg/Mojang_API#UUID_to_Profile_and_Skin.2FCape
				"value": joi.string().empty("").base64({ urlSafe: true, paddingRequired: true }).default("")
					.description("Base64 string of skin from [https://sessionserver.mojang.com/session/minecraft/profile/<UUID\>?unsigned=false](https://wiki.vg/Mojang_API#UUID_to_Profile_and_Skin.2FCape)"),
				"signature": joi.string().empty("").base64({ paddingRequired: true }).default("")
					.description("Base64 string of signed data using Yggdrasil's private key from [https://sessionserver.mojang.com/session/minecraft/profile/<UUID\>?unsigned=false](https://wiki.vg/Mojang_API#UUID_to_Profile_and_Skin.2FCape)"),
			}).default()
		}).default(),
		"spoofPing": joi.object({
			"active": joi.boolean().default(false)
				.description("Whether to spoof the [Status Response packet](https://wiki.vg/Server_List_Ping#Status_Response) when pinging the proxy server"),
			"noResponse": joi.boolean().default(false)
				.description("Whether to cancel the response entirely. Otherwise, the packet described in fakeResponse will be sent."),
			"fakeResponse": joi.object({ // From: https://wiki.vg/Server_List_Ping#Status_Response (default values simulate a normal server)
				"version": joi.object({
					"name": joi.string().default("1.12.2")
						.description("Spoofed server version"),
					"protocol": joi.number().integer().default(340) // From: https://wiki.vg/Protocol_version_numbers
						.description("Spoofed [protocol number](https://wiki.vg/Protocol_version_numbers)")
				}).default(),
				"players": joi.object({
					"max": joi.number().integer().default(20) // From: https://minecraft.fandom.com/wiki/Server.properties#Java_Edition_2 (under "max-players")
						.description("Spoofed max players"),
					"online": joi.number().integer().default(0)
						.description("Spoofed number of players online"),
					"sample": joi.array().items(joi.object({
						"name": usernameSchema
							.description("Spoofed playername"),
						"id": joi.string().uuid({ version: "uuidv4", separator: "-" })
							.description("Spoofed player UUID")
					})).default([])
				}).default(),
				"description": joi.object({
					"text": joi.string().default("A Minecraft server")
						.description("Spoofed MOTD")
				}).default(),
				"favicon": joi.string().default("undefined")
					.description("Spoofed Base64-encoded 64x64 png favicon")
			}).default()
		}).default(),
		"disconnectIfNoController": joi.object({
			"active": joi.boolean().default(false)
				.description("Whether to disconnect if noone is controlling the proxy disconnectIfNoController.delay seconds after a controller disconnects from the proxy while it isn't in queue"),
			"delay": joi.number().min(0).default(7) // Not setting a minimum for this seems dangerous...
				.description("How long to wait (in seconds) after a controller disconnects from the proxy while it isn't in queue before disconnecting from the server")
		}).default(),
		"worldDownloader": joi.object({
			"active": joi.boolean().default(false)
				.description("**\[Warning, Event Thread-Blocking!\]** Whether to use the experimental world downloader"),
			"compression": zlibOptionsSchema.default()
				.description("Settings for packet archive compression. Tweak with caution. The default options maximize memory usage for the fastest speed")
		}).default(),
		"maxThreadpool": joi.object({
			"active": joi.boolean().default(true)
				.description("Whether to set UV_THREADPOOL_SIZE to use all possible CPU logic cores")
		}).default(),
	}).default()
		.description("Settings for experimental features that may be more unstable in resource usage and/or server and version parity"),
	"waitForControllerBeforeConnect": joi.boolean().default(false)
		.description("Whether the proxy will wait for someone to take control before it connects to the server"),
	"notify": joi.object({
		"whenJoining": joi.boolean().default(true)
			.description("Whether to send a toast notification and status webhook message when the proxy joins the server from queue"),
		"whenBelowQueueThreshold": joi.boolean().default(true)
			.description("Whether to send a toast notification and status webhook message when the proxy dips below position `queueThreshold` in queue"),
		"whenControlling": joi.boolean().default(false)
			.description("Whether to send a status webhook message when a controller connects and disconnects from the proxy")
	}).default()
		.description("Settings for what the proxy will send notifications about"),
	"noCliGui": joi.boolean().default(false)
		.description("Whether to disable the cli gui"),
	"coordination": joi.object({
		"active": joi.boolean().default(false)
			.description("Whether to use a [master config file and coordinator](https://github.com/Enchoseon/2based2wait/wiki/How-to-Proxy-Multiple-Accounts)"),
		"path": joi.string().default("./../")
			.description("Path to the folder where the shared master-config.json and coordinator.flag files should go")
	}).default()
		.description("Settings for coordinating multiple proxies")
});

if (process.argv.indexOf("--documentation") !== -1) {
	console.clear();
	const doc = joiToMarkdown(configSchema, true); // Generate documentation with anchor links
	const dir = "./docs/";
	if (!fs.existsSync(dir)) { // Create directory if it doesn't exist
		fs.mkdirSync(dir, {
			"recursive": true
		});
	}
	fs.writeFileSync(dir + "configuration-guide.md", doc); // Write documentation to markdown file
	// Output documentation without any anchor links for the GitHub Wiki, which annoyingly doesn't support anchor links
	console.log("### See [this page](https://github.com/Enchoseon/2based2wait/blob/main/docs/configuration-guide.md) for a better version of this guide with anchor links\n---\n" + joiToMarkdown(configSchema, false));
	process.exit();
}

// =======================
// Process Config & Status
// =======================

// Read config.json
if (typeof global.it !== "function") {
	config = JSON5.parse(fs.readFileSync("config.json"));
} else { // Unless we're running a unit test, in which case read the test config.
	config = JSON5.parse(fs.readFileSync("./test/test-config.json"));
}

// If coordination is active...
if (config.coordination.active) {
	// ... create coordination path folder(s) if it doesn't exist
	const dir = config.coordination.path;
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, {
			recursive: true
		});
	}
	// ... and apply master-config.json overrides if provided
	const masterConfigPath = config.coordination.path + "master-config.json";
	if (fs.existsSync(masterConfigPath)) {
		const masterConfig = JSON5.parse(fs.readFileSync(masterConfigPath));
		config = merge(masterConfig, config);
	}
}

// Validate config
config = validate(config);

// =========
// Functions
// =========

/**
 * Update status object. Returns whether the input being received is different from what's already stored in the object.
 * @param {string} type
 * @param {string} input
 */
function updateStatus(type, input) {
	if (status[type] !== input.toString()) {
		status[type] = input.toString();
		if (config.coordination.active && type === "livechatRelay") { // Update coordinator status if livechatRelay changes
			updateCoordinatorStatus();
		}
		updateGui();
		return true;
	}
	return false;
}

/**
 * Update proxy coordinator status
 */
function updateCoordinatorStatus() {
	// Add or remove the flag
	const flagPath = config.coordination.path + "coordinator.flag";
	if (status.livechatRelay === "true") {
		fs.writeFile(flagPath, config.account.username, (error) => {
			if (error) {
				// logger.log("updateCoordinatorStatus", error, "error");
			}
		});
	} else {
		// Check if the flag is assigned to this proxy
		if (fs.existsSync(flagPath) && fs.readFileSync(flagPath).toString() === config.account.username) {
			fs.unlinkSync(flagPath);
		}
	}
}

/**
 * Display a basic CLI GUI
 */
function updateGui() {
	if (config.noCliGui) {
		return;
	}
	// Cli GUI
	console.clear();
	console.log("\x1b[36m", `
88888                               88888
    8 88888  88888 88888 8888 88888     8 e  e  e 88888 8 88888
    8 8   8  8   8 8     8    88  8     8 8  8  8 8   8 8   8
88888 888888 88888 88888 8888 8   8 88888 8  8  8 88888 8   8
8     8    8 8   8     8 8    88  8 8     8  8  8 8   8 8   8
88888 888888 8   8 88888 8888 88888 88888 8888888 8   8 8   8
	`);
	console.log("\x1b[30m", "");
	console.log("\x1b[37m", "Last Update: [" + getTimestamp() + "]");
	console.log("\x1b[37m", "Account: " + config.account.username);
	console.log("\x1b[37m", "Current Controller: " + status.controller);
	console.log("\x1b[33m", "Current Queue Position: " + status.position);
	console.log("\x1b[33m", "ETA: " + status.eta);
	console.log("\x1b[33m", "Restart: " + status.restart);
	console.log("\x1b[35m", "In Queue Server: " + status.inQueue.toUpperCase());
	if (config.mineflayer.active) {
		console.log("\x1b[35m", "Mineflayer Running: " + status.mineflayer.toUpperCase());
	}
	if (config.coordination.active) {
		console.log("\x1b[32m", "Livechat Relay: " + status.livechatRelay.toUpperCase());
	}
	if (config.ngrok.active) {
		console.log("\x1b[32m", "Ngrok URL: " + status.ngrokUrl);
	}
}

/**
 * Get current timestamp
 */
function getTimestamp(includeTime) {
	var timestamp = new Date();
	timestamp = timestamp.toLocaleString();
	return timestamp.replace(/\//g, "-") // Replace forward-slash with hyphen
		.replace(",", ""); // Remove comma
}

/**
 * Validate config object
 * @param {object} config
 */
function validate() {
	const result = configSchema.validate(config, { // Validate schema
		"abortEarly": false, // (find all errors)
		"allowUnknown": true // (allow undefined values (we'll just set defaults where we can))
	});
	const errors = result.error;
	if (errors) { // If error found, print error to console and kill process
		if (errors.details.length === 1) {
			console.log("\x1b[36m", "Stopped proxy, encountered an error in config.json (you must fix it): \n");
		} else {
			console.log("\x1b[36m", "Stopped proxy, encountered " + errors.details.length + " errors in config.json (you must fix them): \n");
		}
		for (var i = 0; i < errors.details.length; i++) { // Print errors to console
			const error = errors.details[i];
			console.log("\x1b[33m", "ERROR #" + i + ": " + error.message);
			console.log("\x1b[32m", "- Invalid Value: " + error.context.value);
			console.log("\x1b[32m", "- Should Be Type: " + error.type);
			if (i !== errors.details.length) {
				console.log("\x1b[36m", "");
			}
		};
		throw new Error("Couldn't validate config.json");
	}
	return result.value;

}

// ===============
// Joi To Markdown
// ===============

/**
 * Generate markdown documentation from Joi schema.
 * @param {object} schema
 * @param {boolean} includeAnchors
 */
function joiToMarkdown(schema, includeAnchors) {
	var output = "";
	// Convert to JSON
	schema = schema.describe();
	// Get value from path (https://stackoverflow.com/a/70356013)
	const get = (record, path) => path.reduce((record, item) => record[item], record);
	// Traverse configSchema
	for (var [key, value, path, parent] of traverse(schema.keys)) {
		const level = path.length;
		const flags = get(schema.keys, path).flags;
		if (flags && key !== "empty" && key !== "0") { // Don't proceed if the object doesn't have any flags or is empty
			const info = { // Important information about the entry
				"type": get(schema.keys, path).type,
				"default": flags.default,
				"description": flags.description
			};
			if (level !== 1) { // Indent nested entries
				output += indent(level) + "- "
			} else { // Add a newlines in-between top-level entries to stop GitHub's markdown interpreter from merging everything into one giant list
				output += "\n"
			}
			if (includeAnchors) {
				const anchor = path.join("-").replace(/-keys-/g, "-").toLowerCase(); // Create a unique and URL-friendly anchor for the entry
				output += "<span id='" + anchor + "'></span>"; // Add the anchor to an invisible pair of <span> tags
				output += "**[" + key + "](#user-content-" + anchor + ")**"; // Output the entry's name
			} else {
				output += "**" + key + "**"; // Output the entry's name
			}
			output += " <samp>`{type: " + info.type + "}`</samp>"; // Output the entry's type
			if (info.default && info.default.special !== "deep") { // If provided, output the entry's default value(s)
				output += " <samp>`{default: " + JSON.stringify(info.default) + "}`</samp>";
			}
			if (info.description) { // If provided, output the entry's description
				output += " : " + info.description;
			}
			output += "\n";
		}
	}
	return output;
	/**
	 * Traverse through an object (https://stackoverflow.com/a/45628445)
	 * @param {object} o
	 * @param {object} path
	 */
	function* traverse(o, path = []) {
		for (var i in o) {
			const itemPath = path.concat(i);
			yield [i, o[i], itemPath, o];
			if (o[i] !== null && typeof (o[i]) == "object") {
				yield* traverse(o[i], itemPath);
			}
		}
	}
	/**
	 * Return indent for creating nested markdown list
	 * @param {number} level
	 */
	function indent(level) {
		var output = "";
		for (var i = 1; i < level; i++) {
			output += " ";
		}
		return output;
	}
}

// =======
// Exports
// =======

module.exports = {
	config,
	status,
	updateStatus,
	updateCoordinatorStatus,
	configSchema
};