
/**
 * @fileoverview SIP User Agent
 */


/**
 * @augments JsSIP
 * @class Class creating a SIP User Agent.
 */
JsSIP.UA = function(configuration) {
  var events = [
    'connect',
    'disconnect',
    'register',
    'deregister',
    'registrationFailure',
    'call',
    'message'
  ];

  this.configuration = {};
  this.dialogs = {};
  this.registrator = null;

  //User actions outside any session/dialog (MESSAGE)
  this.applicants = {};

  this.sessions = {};
  this.transport = null;
  this.contact = {};
  this.status = JsSIP.c.UA_STATUS_INIT;
  this.error = null;
  this.transactions = {
    nist: {},
    nict: {},
    ist: {},
    ict: {}
  };

  /**
   * Load configuration
   *
   * @throws {JsSIP.exceptions.ConfigurationError}
   */
  if(!configuration || !this.loadConfig(configuration)) {
    this.status = JsSIP.c.UA_STATUS_NOT_READY;
    this.error = JsSIP.c.UA_CONFIGURATION_ERROR;
    throw new JsSIP.exceptions.ConfigurationError();
  } else {
    this.initEvents(events);
  }
};
JsSIP.UA.prototype = new JsSIP.EventEmitter();

//=================
//  High Level API
//=================

/**
 * Notify the UA about network availability.
 */
JsSIP.UA.prototype.networkIsReady = function() {
  console.log('Network Ready notification received');
  // Stablish connection if needed.
  if(this.status === JsSIP.c.UA_STATUS_NOT_READY && this.error === JsSIP.c.UA_NETWORK_ERROR) {
    this.transport.connect();
  }
};

/**
 * Register.
 *
 * @throws {JsSIP.exceptions.NotReadyError} If JsSIP.UA is not ready (see JsSIP.UA.status, JsSIP.UA.error parameters).
 */
JsSIP.UA.prototype.register = function() {
  if(this.status === JsSIP.c.UA_STATUS_READY) {
    this.registrator.register();
  } else {
      throw new JsSIP.exceptions.NotReadyError();
  }
};

/**
 * Deregister.
 * @param {Boolean} [all] deregister all user bindings.
 *
 * @throws {JsSIP.exceptions.NotReadyError} If JsSIP.UA is not ready (see JsSIP.UA.status, JsSIP.UA.error parameters).
 */
JsSIP.UA.prototype.deregister = function(all) {
  if(this.status === JsSIP.c.UA_STATUS_READY) {
    this.registrator.deregister(all);
  } else {
    throw new JsSIP.exceptions.NotReadyError();
  }
};

/**
 * Registration state.
 * @param {Boolean}
 */
JsSIP.UA.prototype.isRegistered = function() {
  if(this.registrator && this.registrator.registered) {
    return true;
  } else {
    return false;
  }
};

/**
 * Connection state.
 * @param {Boolean}
 */
JsSIP.UA.prototype.isConnected = function() {
  if(this.transport) {
    return this.transport.connected;
  } else {
    return false;
  }
};

/**
 * Make an outgoing call.
 *
 * @param {String} target
 * @param {HTMLVideoElement} selfView
 * @param {HTMLVideoElement} remoteView
 * @param {Object} mediaType
 *
 * @throws {JsSIP.exceptions.NotReadyError} If JsSIP.UA is not ready (see JsSIP.UA.status, JsSIP.UA.error parameters).
 * @throws {JsSIP.exceptions.WebRtcNotSupportedError} If rtcweb is not supported by the client.
 * @throws {JsSIP.exceptions.InvalidTargetError} If the calling target is invalid.
 *
 * @returns {JsSIP.OutgoingSession}
 */
JsSIP.UA.prototype.call = function(target, selfView, remoteView, mediaType) {
  var inviteSession;

  if(this.status !== JsSIP.c.UA_STATUS_READY) {
    throw new JsSIP.exceptions.NotReadyError();
  }

  if(!JsSIP.utils.isWebRtcSupported()) {
    console.log(JsSIP.c.LOG_UA +'rtcweb not supported.');
    throw new JsSIP.exceptions.WebRtcNotSupportedError();
  }

  target = JsSIP.utils.normalizeUri(target, this.configuration.domain);
  if (!target) {
    throw new JsSIP.exceptions.InvalidTargetError();
  } else {
    inviteSession = new JsSIP.OutgoingSession(this, target, selfView, remoteView, mediaType);
    return inviteSession;
  }
};

/**
 * Send a message.
 * @param {String} target
 * @param {String} body
 * @param {String} [content_type]
 *
 * @throws {JsSIP.exceptions.NotReadyError} If JsSIP.UA is not ready (see JsSIP.UA.status, JsSIP.UA.error parameters).
 * @throws {JsSIP.exceptions.InvalidTargetError} If the calling target is invalid.
 *
 * @returns {JsSIP.MessageSender}
 */
JsSIP.UA.prototype.message = function(target, body, content_type) {
  var message;

  if(this.status !== JsSIP.c.UA_STATUS_READY) {
    throw new JsSIP.exceptions.NotReadyError();
  }

  target = JsSIP.utils.normalizeUri(target, this.configuration.domain);
  if (!target) {
    throw new JsSIP.exceptions.InvalidTargetError();
  } else {
    message = new JsSIP.MessageSender(this, target, body, content_type);
    return message;
  }
};

/**
 * Gracefully close.
 *
 * @throws {JsSIP.exceptions.NotReadyError} If JsSIP.UA is not ready (see JsSIP.UA.status, JsSIP.UA.error parameters).
 */
JsSIP.UA.prototype.stop = function() {
  var session, applicant,
    ua = this;

  if(this.status !== JsSIP.c.UA_STATUS_READY) {
    throw new JsSIP.exceptions.NotReadyError();
  }

  console.log(JsSIP.c.LOG_UA +'User requested closure.');

  // Close registrator
  if(this.registrator) {
    console.log(JsSIP.c.LOG_UA +'Closing registrator');
    this.registrator.close();
  }

  // Run  _terminate_ on every Session
  for(session in this.sessions) {
    console.log(JsSIP.c.LOG_UA +'Closing session' + session);
    this.sessions[session].terminate();
  }

  // Run  _close_ on every applicant
  for(applicant in this.applicants) {
    this.applicants[applicant].close();
  }

  this.status = JsSIP.c.UA_STATUS_USER_CLOSED;
  this.shutdownGraceTimer = window.setTimeout(
    function() { ua.transport.disconnect(); },
    '5000'
  );
};

/**
 * Connect to the WS server if staus = UA_STATUS_INIT.
 * Resume UA after being closed.
 *
 * @throws {JsSIP.exceptions.NotReadyError} If JsSIP.UA is not ready (see JsSIP.UA.status, JsSIP.UA.error parameters).
 */
JsSIP.UA.prototype.start = function() {
  var server;

  if (this.status === JsSIP.c.UA_STATUS_INIT) {
      server = this.getNextWsServer();
      new JsSIP.Transport(this, server);
  } else if(this.status === JsSIP.c.UA_STATUS_USER_CLOSED) {
    console.log(JsSIP.c.LOG_UA +'Resuming..');
    this.status = JsSIP.c.UA_STATUS_READY;
    this.transport.connect();
  } else if (this.status === JsSIP.c.UA_STATUS_READY) {
    console.log(JsSIP.c.LOG_UA +'UA is in ready status. Not resuming');
  } else {
    throw new JsSIP.exceptions.NotReadyError();
  }
};

//==========================
// Event Handlers
//==========================

/**
 * Transport Close event.
 * @private
 * @event
 * @param {JsSIP.Transport} transport.
 */
JsSIP.UA.prototype.onTransportClosed = function(transport) {
  // Run _onTransportError_ callback on every client transaction using _transport_
  var type, idx,
    client_transactions = ['nict', 'ict', 'nist', 'ist'];

  transport.server.status = JsSIP.c.WS_SERVER_DISCONNECTED;
  console.log(JsSIP.c.LOG_UA +'connection status set to: '+ JsSIP.c.WS_SERVER_DISCONNECTED);

  for(type in client_transactions) {
    for(idx in this.transactions[client_transactions[type]]) {
      this.transactions[client_transactions[type]][idx].onTransportError();
    }
  }

  // Close sessions if GRUU is not being used
  if (!this.contact.pub_gruu) {
    this.closeSessionsOnTransportError();
  }

};

/**
 * Unrecoverable transport event.
 * Connection reattempt logic has been done and didn't success.
 * @private
 * @event
 * @param {JsSIP.Transport} transport.
 */
JsSIP.UA.prototype.onTransportError = function(transport) {
  var server;

  console.log(JsSIP.c.LOG_UA +'Transport ' + transport.server.ws_uri + ' failed');

  // Close sessions.
  //Mark this transport as 'down' and try the next one
  transport.server.status = JsSIP.c.WS_SERVER_ERROR;
  console.log(JsSIP.c.LOG_UA +'connection status set to: '+ JsSIP.c.WS_SERVER_ERROR);

  server = this.getNextWsServer();

  if(server) {
    new JsSIP.Transport(this, server);
  }else {
    this.closeSessionsOnTransportError();
    this.status = JsSIP.c.UA_STATUS_NOT_READY;
    this.error = JsSIP.c.UA_NETWORK_ERROR;
    this.emit('disconnect');
  }
};

/**
 * Transport connection event.
 * @private
 * @event
 * @param {JsSIP.Transport} transport.
 */
JsSIP.UA.prototype.onTransportConnected = function(transport) {
  this.transport = transport;

  transport.server.status = JsSIP.c.WS_SERVER_READY;
  console.log(JsSIP.c.LOG_UA +'connection status set to: '+ JsSIP.c.WS_SERVER_READY);

  if(this.status === JsSIP.c.UA_STATUS_USER_CLOSED) {
    return;
  }

  if(this.configuration.auto_register) {
    if(this.registrator) {
      this.registrator.onTransportConnected();
    } else {
      this.registrator = new JsSIP.Registrator(this, transport);
    }
  }
  this.status = JsSIP.c.UA_STATUS_READY;
  this.error = null;
  this.emit('connect');
};

//=========================
// receiveRequest
//=========================

/**
 * Request reception
 * @private
 * @param {JsSIP.IncomingRequest} request.
 */
JsSIP.UA.prototype.receiveRequest = function(request) {
  var dialog, session,
    method = request.method;

  //Check that Ruri points to us
  if(request.ruri.user !== this.configuration.user) {
    console.log(JsSIP.c.LOG_UA +'Request URI does not point to us');
    request.reply_sl(404, JsSIP.c.REASON_404);
    return;
  }

  // Check transaction
  if(JsSIP.Transactions.checkTransaction(this, request)) {
    return;
  }

  // Create the server transaction
  if(method === JsSIP.c.INVITE) {
    new JsSIP.Transactions.InviteServerTransaction(request, this);
  } else if(method !== JsSIP.c.ACK) {
    new JsSIP.Transactions.NonInviteServerTransaction(request, this);
  }

  /* RFC3261 12.2.2
   * Requests that do not change in any way the state of a dialog may be
   * received within a dialog (for example, an OPTIONS request).
   * They are processed as if they had been received outside the dialog.
   */
  if(method === JsSIP.c.OPTIONS) {
    request.reply(200, JsSIP.c.REASON_200, {
      'Allow': JsSIP.c.ALLOWED_METHODS,
      'Accept': JsSIP.c.ACCEPTED_BODY_TYPES
      }
    );
  }

  // Initial Request
  if(!request.to_tag) {
    if(!this.registrator || (this.registrator && !this.registrator.registered)) {
      // High user does not want to be contacted
      request.reply(410, JsSIP.c.REASON_410);
      return;
    }

    switch(method) {
      case JsSIP.c.MESSAGE:
        JsSIP.messageReceiver(this, request);
        break;
      case JsSIP.c.INVITE:
        if(!JsSIP.utils.isWebRtcSupported()) {
          console.warn(JsSIP.c.LOG_UA +'Call invitation received but rtcweb is not supported');
        } else {
          new JsSIP.IncomingSession(this, request);
        }
        break;
      case JsSIP.c.BYE:
        // Out of dialog BYE received
        request.reply(481, JsSIP.c.REASON_481);
        break;
      case JsSIP.c.CANCEL:
        session = this.findSession(request);
        if(session) {
          session.receiveRequest(request);
        } else {
          console.warn(JsSIP.c.LOG_UA +'Received CANCEL request for a non existent session');
        }
        break;
      case JsSIP.c.ACK:
        /* Absorb it.
         * ACK request whithout a correspondining Invite Transaction
         * and without To tag.
         */
        break;
      default:
        request.reply(405, JsSIP.c.REASON_405);
        break;
    }
  }
  // In-dialog request
  else {
    dialog = this.findDialog(request);

    if(dialog) {
      dialog.receiveRequest(request);
    } else if (method === JsSIP.c.NOTIFY) {
      session = this.findSession(request);
      if(session) {
        session.receiveRequest(request);
      } else {
        console.warn(JsSIP.c.LOG_UA +'Received a NOTIFY request for a non existent session');
        request.reply(481, 'Subscription does not exist');
      }
    }
    /* RFC3261 12.2.2
     * Request with to tag, but no matching dialog found.
     * Exception: ACK for an Invite request for which a dialog has not
     * been created.
     */
    else {
      if(method !== JsSIP.c.ACK) {
        request.reply(481, JsSIP.c.REASON_481);
      }
    }
  }
};

//=================
// Utils
//=================

/**
 * Get the session to which the request belongs to, if any.
 * @private
 * @param {JsSIP.IncomingRequest} request.
 * @returns {JsSIP.OutgoingSession|JsSIP.IncomingSession|null}
 */
JsSIP.UA.prototype.findSession = function(request) {
  var
    sessionIDa = request.call_id + request.from_tag,
    sessionA = this.sessions[sessionIDa],
    sessionIDb = request.call_id + request.to_tag,
    sessionB = this.sessions[sessionIDb];

  if(sessionA) {
    return sessionA;
  } else if(sessionB) {
    return sessionB;
  } else {
    return null;
  }
};

/**
 * Get the dialog to which the request belogns to, if any.
 * @private
 * @param {JsSIP.IncomingRequest}
 * @returns {JsSIP.Dialog|null}
 */
JsSIP.UA.prototype.findDialog = function(request) {
  var
    id = request.call_id + request.from_tag + request.to_tag,
    dialog = this.dialogs[id];

  if(dialog) {
    console.log(JsSIP.c.LOG_UA +'dialogs', 'dialog found');
    return dialog;
  } else {
    id = request.call_id + request.to_tag + request.from_tag;
    dialog = this.dialogs[id];
    if(dialog) {
      console.log(JsSIP.c.LOG_UA +'dialogs', 'dialog found');
      return dialog;
    } else {
      console.log(JsSIP.c.LOG_UA +'dialogs', 'No dialog found');
      return null;
    }
  }
};

/**
 * Retrieve the next server to which connect.
 * @private
 * @returns {Object} outbound_proxy_set
 */
JsSIP.UA.prototype.getNextWsServer = function() {
  // Order servers by weight
  var idx, outbound_proxy_set,
    candidates = [];

  for (idx in this.configuration.outbound_proxy_set) {
    outbound_proxy_set = this.configuration.outbound_proxy_set[idx];

    if (outbound_proxy_set.status === 2) {
      continue;
    } else if (candidates.length === 0) {
      candidates.push(outbound_proxy_set);
    } else if (outbound_proxy_set.weight > candidates[0].weight) {
      candidates = [];
      candidates.push(outbound_proxy_set);
    } else if (outbound_proxy_set.weight === candidates[0].weight) {
      candidates.push(outbound_proxy_set);
    }
  }

  idx = Math.floor((Math.random()* candidates.length));

  return candidates[idx];
};

/**
 * Close all sessions on transport error.
 * @private
 */
JsSIP.UA.prototype.closeSessionsOnTransportError = function() {
  var idx;

  // Run _transporError_ for every Session
  for(idx in this.sessions) {
    this.sessions[idx].onTransportError();
  }
  // Call registrator _onTransportClosed_
  if(this.registrator){
    this.registrator.onTransportClosed();
  }
};

/**
 * Configuration load.
 * @private
 * returns {Boolean}
 */
JsSIP.UA.prototype.loadConfig = function(configuration) {
  // Settings and default values
  var name, parameter, attribute, idx, uri, host, ws_server, contact,
    settings = {
      /* Host address
      * Value to be set in Via sent_by and host part of Contact FQDN
      */
      via_host: Math.random().toString(36).substr(2, 12) + '.invalid',
      /* Registration parameters */
      register_expires: 600,
      register_min_expires: 120,
      auto_register: true,
      /* Transport related parameters */
      secure_transport: false,
      max_reconnection: 3,
      reconnection_timeout: 4,

      no_answer_timeout: 30,
      stun_server: 'stun.l.google.com:19302',
      /* Hacks */
      hack_use_via_tcp: false
    };

  // Pre-Configuration

  /* Allow defining outbound_proxy_set parameter as:
   *  String: "host"
   *  Array of Strings: ["host_1", "host_2"]
   *  Array of Objects: [{host:"host_1", weight:1}, {host:"host_2", weight:0}]
   *  Array of Objects and Strings: [{host:"host_1"}, "host_2"]
   */
  if (typeof configuration.outbound_proxy_set === 'string'){
    configuration.outbound_proxy_set = [{host:configuration.outbound_proxy_set}];
  } else if (configuration.outbound_proxy_set instanceof Array) {
    for(idx in configuration.outbound_proxy_set) {
      if (typeof configuration.outbound_proxy_set[idx] === 'string'){
        configuration.outbound_proxy_set[idx] = {host:configuration.outbound_proxy_set[idx]};
      }
    }
  }

  // Check Mandatory parameters
  for(name in JsSIP.UA.configuration_check.mandatory) {
    parameter = configuration[name];

    if(!parameter) {
      console.error('Missing config parameter: ' + name);
      return false;
    } else if(JsSIP.UA.configuration_check.mandatory[name](parameter)) {
      settings[name]= parameter;
    } else {
      console.error('Bad configuration parameter: ' + name);
      return false;
    }
  }

  // Check Optional parameters
  for(name in JsSIP.UA.configuration_check.optional) {
    parameter = configuration[name];

    if(parameter) {
      if(JsSIP.UA.configuration_check.optional[name](parameter)) {
        settings[name] = parameter;
      } else {
        console.error('Bad configuration parameter: ' + name);
        return false;
      }
    }
  }

  // Post Configuration Process

  // Instance-id for GRUU
  settings.instance_id = JsSIP.utils.newUUID();

  // Create a jssip_id parameter which is a static random tag of length 5
  //for this instance.
  settings.jssip_id = Math.random().toString(36).substr(2, 5);

  uri = JsSIP.grammar_sip.parse(settings.uri, 'lazy_uri');

  settings.user = uri.user;
  settings.domain = uri.host;

  // Check whether authorization_user is explicitly defined and take user value otherwise.
  if (!settings.authorization_user) {
    settings.authorization_user = settings.user;
  }

  // Create the From uri
  settings.from_uri = (uri.scheme ? '':'sip:') + settings.uri;

  if(settings.display_name) {
    settings.from_uri = '"' + settings.display_name + '" <' + settings.from_uri + '>';
  }

  // User no_answer_timeout
  settings.no_answer_timeout = settings.no_answer_timeout * 1000;

  // Create the Via header value (excepting branch parameter)
  settings.via_core_value = 'SIP/2.0/' + (settings.hack_use_via_tcp ? 'TCP' : (settings.secure_transport ? 'WSS':'WS')) + ' ' + settings.via_host;

  // Transports
  for (idx in configuration.outbound_proxy_set) {
    ws_server = JsSIP.grammar_sip.parse(settings.outbound_proxy_set[idx].host, 'hostport');

    settings.outbound_proxy_set[idx].ws_uri = (settings.secure_transport ? 'wss':'ws') + '://' + ws_server.host + (ws_server.port ? ':' + ws_server.port : '');

    settings.outbound_proxy_set[idx].ws_uri += (settings.outbound_proxy_set[idx].ws_path)? '/' + settings.outbound_proxy_set[idx].ws_path :'/';
    settings.outbound_proxy_set[idx].ws_uri += (settings.outbound_proxy_set[idx].ws_query)? '?' + settings.outbound_proxy_set[idx].ws_query :'';

    settings.outbound_proxy_set[idx].sip_uri = '<sip:' + ws_server.host + (ws_server.port ? ':' + ws_server.port : '') + ';transport=ws;lr>';

    if (!settings.outbound_proxy_set[idx].weight) {
      settings.outbound_proxy_set[idx].weight = 0;
    }

    settings.outbound_proxy_set[idx].status = 0;
  }

  contact = {
    uri: {value: 'sip:' + uri.user + '@' + settings.via_host + ';transport=ws', writable: false, configurable: false}
  };
  Object.defineProperties(this.contact, contact);

  // Fill the value of the configuration_skeleton
  for(attribute in settings) {
    JsSIP.UA.configuration_skeleton[attribute].value = settings[attribute];
  }

  Object.defineProperties(this.configuration, JsSIP.UA.configuration_skeleton);

  // Clean JsSIP.UA.configuration_skeleton
  for(attribute in settings) {
    JsSIP.UA.configuration_skeleton[attribute].value = '';
  }

  return true;
};

//============================
// Class Methods / Attributes
//============================

/**
 * Configuration Object skeleton.
 * @private
 */
JsSIP.UA.configuration_skeleton = (function() {
  var idx,  parameter,
    skeleton = {},
    parameters = [
      // Internal parameters
      "instance_id",
      "jssip_id",
      "max_reconnection",

      "reconnection_timeout",
      "register_min_expires",
      "secure_transport",

      // Mandatory user configurable parameters
      "outbound_proxy_set",
      "password",
      "uri",

      // Optional user configurable parameters
      "authorization_user",
      "auto_register", // true.
      "display_name",
      "hack_use_via_tcp", // false.
      "stun_server",
      "no_answer_timeout", // 30 seconds.
      "register_expires", // 600 seconds.
      "via_host", // random.

      // Post-configuration generated parameters
      "domain",
      "from_uri",
      "via_core_value",
      "user"
    ];

  for(idx in parameters) {
    parameter = parameters[idx];
    skeleton[parameter] = {
      value: '',
      writable: false,
      configurable: false
    };
  }

  return skeleton;
}());

/**
 * Configuration checker.
 * @private
 * @return {Boolean}
 */
JsSIP.UA.configuration_check = {
  mandatory: {
    outbound_proxy_set: function(outbound_proxy_set) {
      var idx, url;

      if (outbound_proxy_set.length === 0) {
        return false;
      }

      for (idx in outbound_proxy_set) {
        if (!outbound_proxy_set[idx].host) {
          console.log(JsSIP.c.LOG_UA +'Missing "host" attribute in outbound_proxy_set parameter');
          return false;
        }
        if (outbound_proxy_set[idx].weight && !Number(outbound_proxy_set[idx].weight)) {
          console.log(JsSIP.c.LOG_UA +'"weight" attribute in outbound_proxy_set parameter must be a Number');
          return false;
        }

        url = JsSIP.grammar_sip.parse(outbound_proxy_set[idx].host, 'hostport');

        if(url === -1) {
          console.log(JsSIP.c.LOG_UA +'Invalid "host" attribute in outbound_proxy_set parameter: ' + outbound_proxy_set[idx].host);
          return false;
        }
      }
      return true;
    },
    uri: function(uri) {
      var parsed;

      parsed = JsSIP.grammar_sip.parse(uri, 'lazy_uri');

      if(parsed === -1) {
        console.log(JsSIP.c.LOG_UA +'Invalid uri: ' + uri);
        return false;
      } else if (!parsed.host) {
        console.log(JsSIP.c.LOG_UA +'Invalid uri. Missing uri domain.');
        return false;
      } else {
        return true;
      }
    },
    password: function(password) {
      if(JsSIP.grammar_sip.parse(password, 'password') === -1) {
        return false;
      } else {
        return true;
      }
    }
  },
  optional: {
    authorization_user: function(authorization_user) {
      if(JsSIP.grammar_sip.parse('"'+ authorization_user +'"', 'quoted_string') === -1) {
        return false;
      } else {
        return true;
      }
    },
    auto_register: function(auto_register) {
      if(auto_register !== true && auto_register !== false) {
        console.log(JsSIP.c.LOG_UA +'auto_register must be true or false');
        return false;
      } else {
        return true;
      }
    },
    display_name: function(display_name) {
      if(JsSIP.grammar_sip.parse(display_name, 'display_name') === -1) {
        return false;
      } else {
        return true;
      }
    },
    via_host: function(via_host) {
      if(JsSIP.grammar_sip.parse(via_host, 'host') === -1) {
        return false;
      } else {
        return true;
      }
    },
    secure_transport:function(secure_transport) {
      if(secure_transport !== true && secure_transport !== false) {
        return false;
      } else {
        return true;
      }
    },
    register_expires: function(register_expires) {
      if(!Number(register_expires)) {
        return false;
      } else {
        return true;
      }
    },
    stun_server: function(stun_server) {
      var parsed;

      parsed = JsSIP.grammar_sip.parse(stun_server, 'hostport');

      if(parsed === -1) {
        console.log(JsSIP.c.LOG_UA +'Invalid stun_server: ' + stun_server);
        return false;
      } else {
        return true;
      }
    },
    no_answer_timeout: function(no_answer_timeout) {
      if(!Number(no_answer_timeout)) {
        return false;
      } else if(no_answer_timeout < 0 || no_answer_timeout > 600) {
        return false;
      } else {
        return true;
      }
    },
    hack_use_via_tcp: function(hack_use_via_tcp) {
      if(hack_use_via_tcp !== true && hack_use_via_tcp !== false) {
        return false;
      } else {
        return true;
      }
    }
  }
};