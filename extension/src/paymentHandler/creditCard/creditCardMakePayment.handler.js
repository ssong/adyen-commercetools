const fetch = require('node-fetch')
const _ = require('lodash')
const configLoader = require('../../config/config')
const c = require('../../config/constants')
const pU = require('../payment-utils')

const config = configLoader.load()

function isSupported (paymentObject) {
  const isAdyen = paymentObject.paymentMethodInfo.paymentInterface === 'ctp-adyen-integration'
  const isCreditCard = paymentObject.paymentMethodInfo.method === 'creditCard'
  const hasReferenceField = !_.isNil(paymentObject.custom.fields.reference)
  const hasEncryptedCardNumber = !_.isNil(paymentObject.custom.fields.encryptedCardNumber)
  const hasEncryptedExpiryMonth = !_.isNil(paymentObject.custom.fields.encryptedExpiryMonth)
  const hasEncryptedExpiryYear = !_.isNil(paymentObject.custom.fields.encryptedExpiryYear)
  const hasEncryptedSecurityCode = !_.isNil(paymentObject.custom.fields.encryptedSecurityCode)
  const hasReturnUrl = !_.isNil(paymentObject.custom.fields.returnUrl)
  const transaction = pU.getChargeTransactionInitOrPending(paymentObject)
  const hasTransaction = _.isObject(transaction)
  const hasMakePaymentInteraction = paymentObject.interfaceInteractions
    .some(i => i.fields.type === 'makePayment')
  return !hasMakePaymentInteraction
    && hasEncryptedCardNumber
    && hasEncryptedExpiryMonth
    && hasEncryptedExpiryYear
    && hasEncryptedSecurityCode
    && hasReturnUrl
    && isAdyen
    && isCreditCard
    && hasReferenceField
    && hasTransaction
}

async function handlePayment (paymentObject) {
  const { request, response } = await _makePayment(paymentObject)
  // for statusCodes, see https://docs.adyen.com/developers/development-resources/response-handling
  const interfaceInteractionStatus = response.status === 200 ? c.SUCCESS : c.FAILURE
  const body = await response.json()
  const actions = [
    {
      action: 'addInterfaceInteraction',
      type: { key: c.CTP_INTERFACE_INTERACTION },
      fields: {
        timestamp: new Date(),
        response: JSON.stringify(body),
        request: JSON.stringify(request),
        type: 'makePayment',
        status: interfaceInteractionStatus
      }
    }
  ]
  if (body.pspReference)
    actions.push({
      action: 'setInterfaceId',
      interfaceId: body.pspReference
    })
  if (body.resultCode) {
    const resultCode = body.resultCode.toLowerCase()
    if (resultCode === c.REDIRECT_SHOPPER.toLowerCase()) {
      const { MD } = body.redirect.data
      actions.push({
        action: 'setCustomField',
        name: 'MD',
        value: MD
      })
      const { PaReq } = body.redirect.data
      actions.push({
        action: 'setCustomField',
        name: 'PaReq',
        value: PaReq
      })
      const { paymentData } = body
      actions.push({
        action: 'setCustomField',
        name: 'paymentData',
        value: paymentData
      })
      const redirectUrl = body.redirect.url
      actions.push({
        action: 'setCustomField',
        name: 'redirectUrl',
        value: redirectUrl
      })
      const redirectMethod = body.redirect.method
      actions.push({
        action: 'setCustomField',
        name: 'redirectMethod',
        value: redirectMethod
      })
    }
    const transaction = pU.getChargeTransactionInitOrPending(paymentObject)
    actions.push({
      action: 'changeTransactionState',
      transactionId: transaction.id,
      state: _.capitalize(pU.getMatchingCtpState(body.resultCode.toLowerCase()))
    })
  }
  return {
    version: paymentObject.version,
    actions
  }
}

async function _makePayment (paymentObject) {
  const transaction = pU.getChargeTransactionInitOrPending(paymentObject)
  const body = {
    amount: {
      currency: transaction.amount.currencyCode,
      value: transaction.amount.centAmount
    },
    reference: paymentObject.custom.fields.reference,
    paymentMethod: {
      type: 'scheme',
      encryptedCardNumber: paymentObject.custom.fields.encryptedCardNumber,
      encryptedExpiryMonth: paymentObject.custom.fields.encryptedExpiryMonth,
      encryptedExpiryYear: paymentObject.custom.fields.encryptedExpiryYear,
      encryptedSecurityCode: paymentObject.custom.fields.encryptedSecurityCode
    },
    returnUrl: paymentObject.custom.fields.returnUrl,
    merchantAccount: config.adyen.merchantAccount
  }
  if (paymentObject.custom.fields.holderName)
    body.holderName = paymentObject.custom.fields.holderName
  if (paymentObject.custom.fields.executeThreeD)
    body.additionalData = {
      executeThreeD: paymentObject.custom.fields.executeThreeD.toString()
    }
  if (paymentObject.custom.fields.browserInfo) {
    const browserInfo = JSON.parse(paymentObject.custom.fields.browserInfo)
    body.browserInfo = browserInfo
  }
  const request = {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'x-api-key': config.adyen.apiKey, 'Content-Type': 'application/json' }
  }
  const resultPromise = await fetch(`${config.adyen.apiBaseUrl}/payments`, request)

  return { response: await resultPromise, request }
}

module.exports = { isSupported, handlePayment }
