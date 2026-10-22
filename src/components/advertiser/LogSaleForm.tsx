import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { InputGroup, InputField } from "../../components/input-group";
import { FederatedAddressInput } from "../shared/FederatedAddressInput";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { useWeb3 } from "../../hooks/useWeb3";
import { useNotification } from "../../context/NotificationContext";
import {
  generateAESKey,
  encryptPayload,
  wrapAESKey,
  getPublicKeyForAddress,
} from "../../lib/crypto";
import { resolveRecipient } from "../../lib/stellar";
import type { RecipientResolution } from "../../lib/stellar";
import { logSaleSchema, getFieldErrors } from "../../lib/validation";
import { dispatchWebhookEvent, triggerConversionPostback } from "../../lib/webhookEngine";
import { Shield, Zap, Users, FileKey } from "lucide-react";

export const LogSaleForm = () => {
  const [affiliateAddress, setAffiliateAddress] = useState("");
  const [affiliateResolution, setAffiliateResolution] = useState<RecipientResolution | null>(null);
  const [saleAmount, setSaleAmount] = useState("");
  const [campaignAddress, setCampaignAddress] = useState("");
  const [customerData, setCustomerData] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { getCampaignContract, userAddress } = useWeb3();
  const { showNotification } = useNotification();

  const clearError = (field: string) => {
    setErrors((prev) => ({ ...prev, [field]: "" }));
  };

  const handleLogSale = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrors({});

    const result = logSaleSchema.safeParse({
      campaignAddress,
      affiliateAddress,
      saleAmount,
      customerData: customerData || undefined,
    });

    if (!result.success) {
      setErrors(getFieldErrors(result.error));
      return;
    }

    if (!userAddress) {
      showNotification({
        type: "error",
        title: "Wallet Not Connected",
        message: "Connect your wallet before logging a sale.",
      });
      return;
    }

    // Never submit an unresolved federation string: resolve on demand if the
    // field is still mid-lookup, otherwise use the cached resolution.
    const resolution = affiliateResolution ?? (await resolveRecipient(affiliateAddress));
    if (!resolution.address || (resolution.status !== "raw" && resolution.status !== "federated")) {
      showNotification({
        type: "warning",
        title: "Recipient Not Verified",
        message:
          resolution.error || "Resolve the affiliate address or paste their raw G... public key.",
      });
      return;
    }
    const recipientAddress = resolution.address;

    const { data } = result;

    // Private campaigns only credit approved affiliates. Checked before any
    // encryption work so the advertiser sees why. The id is already validated
    // as a u32 by the schema, so this cannot throw on an out-of-range value.
    if (/^\d+$/.test(data.campaignAddress)) {
      const access = getAffiliateAccess(data.campaignAddress, data.affiliateAddress);
      if (!access.allowed) {
        showNotification({
          type: "error",
          title: "Affiliate Not Approved",
          message: access.reason,
        });
        return;
      }
    }

    setIsLoading(true);

    try {
      const campaignContract = getCampaignContract(data.campaignAddress);

      showNotification({
        type: "info",
        title: "Encrypting Data",
        message: "Securing sale information...",
      });

      const aesKey = await generateAESKey();

      const payload = {
        customer: data.customerData || "Anonymous Customer",
        saleId: `SALE_${Date.now()}`,
        product: "Digital Product",
        timestamp: new Date().toISOString(),
        metadata: "Additional sale information",
      };
      const encryptedPayload = await encryptPayload(payload, aesKey);

      const advertiserPublicKey = await getPublicKeyForAddress(userAddress);
      const affiliatePublicKey = await getPublicKeyForAddress(recipientAddress);

      const advertiserWrappedKey = await wrapAESKey(aesKey, advertiserPublicKey);
      const affiliateWrappedKey = await wrapAESKey(aesKey, affiliatePublicKey);

      showNotification({
        type: "info",
        title: "Transaction Submitted",
        message: "Logging encrypted sale...",
      });

      const tx = await campaignContract.logSale(
        advertiserWrappedKey,
        affiliateWrappedKey,
        encryptedPayload,
      );

      await tx.wait();

      await triggerConversionPostback(data.campaignAddress, recipientAddress, data.saleAmount);
      await dispatchWebhookEvent("conversion", {
        campaign: data.campaignAddress,
        affiliate: recipientAddress,
        amount: data.saleAmount,
        timestamp: new Date().toISOString(),
      });

      showNotification({
        type: "success",
        title: "Sale Logged",
        message: "Encrypted sale recorded on-chain",
      });

      setAffiliateAddress("");
      setAffiliateResolution(null);
      setSaleAmount("");
      setCampaignAddress("");
      setCustomerData("");
    } catch (error: any) {
      console.error("Error logging sale:", error);
      showNotification({
        type: "error",
        title: "Sale Log Failed",
        message: error.message || "Failed to log sale",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-extrabold text-zinc-900 dark:text-white tracking-tight">
          Log a Sale
        </h2>
        <p className="text-zinc-500 dark:text-zinc-400 mt-2 font-medium">
          Record a converted sale against your campaign and affiliate.
        </p>
      </div>

      <Card className="border border-slate-200 dark:border-zinc-800 shadow-sm rounded-3xl bg-white dark:bg-zinc-900/50">
        <CardHeader className="pb-6 pt-8 px-8">
          <div className="flex items-center space-x-4">
            <div className="w-14 h-14 bg-zinc-900 dark:bg-indigo-600 rounded-xl flex items-center justify-center shadow-md">
              <Zap className="w-7 h-7 text-white" />
            </div>
            <div>
              <CardTitle className="text-2xl font-bold text-zinc-900 dark:text-white">
                Conversion Tracking
              </CardTitle>
              <CardDescription className="text-zinc-500 dark:text-zinc-400 mt-1">
                Log affiliate-sourced sales and distribute escrowed payouts.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="px-8 pb-8">
          <form onSubmit={handleLogSale} noValidate>
            <InputGroup className="space-y-8">
              <InputField
                label="Campaign Address"
                description="Soroban contract address (C…) containing the sale"
                error={errors.campaignAddress}
                required
              >
                <Input
                  value={campaignAddress}
                  onChange={(e) => {
                    setCampaignAddress(e.target.value);
                    clearError("campaignAddress");
                  }}
                  placeholder="CCAMPAIGN... (56-char Soroban Contract Address)"
                  variant={errors.campaignAddress ? "error" : "default"}
                  className="h-12 border-slate-200 dark:border-zinc-800 focus:ring-indigo-600 dark:focus:ring-indigo-500 rounded-xl bg-slate-50 dark:bg-zinc-950 font-mono"
                />
              </InputField>

              <div className="grid md:grid-cols-2 gap-6">
                <InputField
                  label="Affiliate Address"
                  description="Public key or federation address (e.g. affiliate*stormsale.io)"
                  error={errors.affiliateAddress}
                  required
                >
                  <FederatedAddressInput
                    value={affiliateAddress}
                    onChange={(value) => {
                      setAffiliateAddress(value);
                      clearError("affiliateAddress");
                    }}
                    onResolved={setAffiliateResolution}
                    placeholder="GAFFILIATE... or affiliate*stormsale.io"
                    required
                    inputClassName="h-12 border-slate-200 dark:border-zinc-800 focus:ring-indigo-600 dark:focus:ring-indigo-500 rounded-xl bg-slate-50 dark:bg-zinc-950 font-mono"
                  />
                </InputField>

                <InputField
                  label="Sale Amount"
                  description="Amount paid out to the affiliate from the campaign escrow"
                  error={errors.saleAmount}
                  required
                >
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={saleAmount}
                    onChange={(e) => {
                      setSaleAmount(e.target.value);
                      clearError("saleAmount");
                    }}
                    placeholder="e.g., 100.50"
                    variant={errors.saleAmount ? "error" : "default"}
                    className="h-12 border-slate-200 dark:border-zinc-800 focus:ring-indigo-600 dark:focus:ring-indigo-500 rounded-xl bg-slate-50 dark:bg-zinc-950"
                  />
                </InputField>
              </div>

              <InputField
                label="Customer Data"
                description="Encrypted customer information tied to the sale"
                error={errors.customerData}
              >
                <Input
                  value={customerData}
                  onChange={(e) => {
                    setCustomerData(e.target.value);
                    clearError("customerData");
                  }}
                  placeholder="Optional customer details"
                  variant={errors.customerData ? "error" : "default"}
                  className="h-12 border-slate-200 dark:border-zinc-800 focus:ring-indigo-600 dark:focus:ring-indigo-500 rounded-xl bg-slate-50 dark:bg-zinc-950"
                />
              </InputField>

              {/* Security Notice */}
              <div className="bg-indigo-50 dark:bg-indigo-500/10 p-6 rounded-2xl border border-indigo-100 dark:border-indigo-500/20">
                <div className="flex items-start space-x-4">
                  <Shield className="w-6 h-6 text-indigo-600 dark:text-indigo-400 mt-1" />
                  <div>
                    <h4 className="font-bold text-indigo-900 dark:text-indigo-300">
                      Encryption Notice
                    </h4>
                    <p className="text-sm font-medium text-indigo-700 dark:text-indigo-400 mt-2 leading-relaxed">
                      Sale data is encrypted client-side and stored on-chain only in wrapped form.
                      Only the advertiser and the authorized affiliate can decrypt it.
                    </p>
                  </div>
                </div>
              </div>

              <Button
                type="submit"
                loading={isLoading}
                cooldown
                className="w-full h-14 bg-zinc-900 hover:bg-zinc-800 dark:bg-indigo-600 dark:hover:bg-indigo-500 text-white text-lg font-bold shadow-lg rounded-xl transition-all"
              >
                {isLoading ? (
                  <div className="flex items-center space-x-3">
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Logging Sale...</span>
                  </div>
                ) : (
                  <div className="flex items-center space-x-2">
                    <FileKey className="w-5 h-5" />
                    <span>Log Sale</span>
                  </div>
                )}
              </Button>
            </InputGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
