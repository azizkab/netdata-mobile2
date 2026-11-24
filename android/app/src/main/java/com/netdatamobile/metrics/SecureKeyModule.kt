package com.netdatamobile.metrics

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Fournit la clé de chiffrement de la base SQLite.
 * La clé est générée aléatoirement au premier lancement, puis stockée chiffrée
 * (AES-256-GCM) avec une clé maître qui ne quitte jamais l'Android Keystore.
 */
class SecureKeyModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "SecureKey"

  private val masterAlias = "netdata_db_master"
  private val prefsName = "netdata_secure"
  private val prefKey = "db_key"

  private fun masterKey(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(masterAlias, null) as? SecretKey)?.let { return it }

    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        masterAlias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  @ReactMethod
  fun getDatabaseKey(promise: Promise) {
    try {
      val prefs = reactContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
      val master = masterKey()
      val stored = prefs.getString(prefKey, null)

      if (stored != null) {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val iv = bytes.copyOfRange(0, 12)
        val encrypted = bytes.copyOfRange(12, bytes.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, master, GCMParameterSpec(128, iv))
        promise.resolve(String(cipher.doFinal(encrypted), Charsets.UTF_8))
        return
      }

      val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
      val dbKey = raw.joinToString("") { "%02x".format(it) }

      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, master)
      val encrypted = cipher.doFinal(dbKey.toByteArray(Charsets.UTF_8))
      prefs.edit()
        .putString(prefKey, Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP))
        .commit()

      promise.resolve(dbKey)
    } catch (e: Exception) {
      promise.reject("KEY_ERROR", e)
    }
  }
}