/**
 * Owns one request/response exchange over a named runtime Port.
 */
(function(global){
  'use strict';

  function asError(value, fallbackMessage){
    if (value && typeof value === 'object' && typeof value.message === 'string'){
      return value;
    }
    return new Error(String(value || fallbackMessage || 'Runtime port request failed'));
  }

  function run({
    portName,
    startMessage,
    fallbackErrorMessage,
    onProgress,
    mapResult,
    mapError,
    onPortOpened,
    onPortClosed,
    onDisconnectError
  } = {}){
    return new Promise((resolve, reject) => {
      let port = null;
      let settled = false;
      let opened = false;

      const dispose = () => {
        if (!port){
          return;
        }
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        if (opened){
          opened = false;
          onPortClosed?.(port);
        }
      };
      const finish = (callback, value) => {
        if (settled){
          return;
        }
        settled = true;
        // Remove listeners before our disconnect so completion cannot be
        // replaced by the resulting onDisconnect notification.
        dispose();
        if (port){
          try{
            port.disconnect();
          }catch(error){
            onDisconnectError?.(error);
          }
        }
        callback(value);
      };
      const onMessage = (message) => {
        if (message?.type === 'progress'){
          onProgress?.(message);
          return;
        }
        if (message?.type === 'result'){
          try{
            finish(resolve, typeof mapResult === 'function' ? mapResult(message) : message.result);
          }catch(error){
            finish(reject, error);
          }
          return;
        }
        if (message?.type === 'error'){
          try{
            const mapped = typeof mapError === 'function' ? mapError(message) : message.error;
            finish(reject, asError(mapped, fallbackErrorMessage));
          }catch(error){
            finish(reject, error);
          }
        }
      };
      const onDisconnect = () => {
        const runtimeError = browser.runtime.lastError;
        finish(reject, new Error(runtimeError?.message || fallbackErrorMessage));
      };

      try{
        port = browser.runtime.connect({ name: portName });
        opened = true;
        onPortOpened?.(port);
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(onDisconnect);
        port.postMessage(startMessage);
      }catch(error){
        finish(reject, error);
      }
    });
  }

  function cancel(port, { reason, onError } = {}){
    if (!port){
      return false;
    }
    try{
      port.postMessage({
        type: 'cancel',
        reason: String(reason || 'cancelled')
      });
      port.disconnect();
      return true;
    }catch(error){
      onError?.(error);
      return false;
    }
  }

  global.NCSharingPortRequest = Object.freeze({ run, cancel });
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
